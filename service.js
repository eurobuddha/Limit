/**
 * Limit DEX — Background Service
 *
 * GTC (good-till-cancelled) auto-renewal + Edit engine. Runs whenever the node is up (UI open or not),
 * so a GTC order is re-placed before it can hit the 1500-block expiry, and a user-initiated Edit
 * completes even if the page is closed right after.
 *
 * IMPORTANT — why this is a two-transaction CANCEL then RECREATE, not a "refresh in place":
 * the V3/V4 owner-signed branch requires VERIFYOUT(@INPUT PREVSTATE(1) ...), i.e. the owner spend
 * MUST pay out to the maker's OWN address (port 1), NOT back to the contract. The old v0.5.x
 * refresh-in-place output back to the contract and silently Script-FAILed at mining (removed in
 * v1.0.15). So: (1) CANCEL — owner-signed spend returns the locked funds to the wallet; (2) RECREATE
 * — a fresh `send` re-locks those wallet funds into a NEW order coin. Ported from the native app's
 * LimitProcessor state machine.
 *
 * SINGLE ACTOR: only this service posts the cancel + recreate for renewals AND edits. The page
 * (lint.js) merely writes an intent row into the shared MDS SQL table `gtc_renewals` (the page and
 * this service are separate JS contexts sharing only MDS SQL, not localStorage). Persist-before-
 * broadcast + the row surviving restarts is what makes a mid-flight cancel->recreate restart-safe.
 */

var USDT_ID = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
var SCRIPT_V4 = 'LET u=0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90 IF @TOKENID NEQ 0x00 THEN IF @TOKENID NEQ u THEN RETURN FALSE ENDIF ENDIF IF PREVSTATE(3) NEQ 0x00 THEN IF PREVSTATE(3) NEQ u THEN RETURN FALSE ENDIF ENDIF IF SIGNEDBY(PREVSTATE(0)) THEN ASSERT VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) RETURN TRUE ENDIF IF @COINAGE GT 1500 THEN ASSERT VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) RETURN TRUE ENDIF ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE) RETURN TRUE';
var SCRIPT_ADDR_V4 = "0x94F2CB876903FAED64EA4C9C4B7FD602BAC5CD59F9EBC38AB0C4A0F0B346807F";

// Constants — verbatim from the native LimitContract / LimitProcessor.
var EXPIRY_BLOCKS = 1500;
var RENEW_AT = 500;              // renew a GTC order once it reaches this age (wide 500..1500 window)
var RECREATE_WAIT_BLOCKS = 4;    // blocks to let a posted recreate mine before re-posting (anti double-create)
var FUNDS_MISSING_GIVEUP = 3;    // consecutive scans of "funds not back" => the order was FILLED, not cancelled
var MAX_RECREATE_RETRIES = 5;    // give up re-locking after this many hard errors (funds safe in wallet)
var MAX_RENEW_PER_BLOCK = 2;

var KEYS_REFRESH_BLOCKS = 25;    // reload the wallet key set this often (picks up keys created post-start)
var CANCELLED_PRUNE_BLOCKS = 2000; // forget a manual-cancel suppression marker after this many blocks

var MY_KEYS = {};                // node wallet pubkeys {pk:true}
var CUR_BLOCK = 0;
var LAST_KEYS_BLOCK = 0;
var SVC_READY = false;
var BUSY = {};                   // orderIds with a cancel/recreate MDS post in flight (transient, in-memory)

MDS.init(function (msg) {
    if (msg.event === "inited") {
        // Register V4 so `coins address:` returns the book even if the page never opened. Idempotent.
        MDS.cmd('newscript trackall:false script:"' + SCRIPT_V4 + '"', function () {});
        ensureTable(function () {
            loadMyKeys(function () { SVC_READY = true; MDS.log("Limit GTC service ready — " + Object.keys(MY_KEYS).length + " keys"); });
        });
    }
    if (msg.event === "NEWBLOCK") {
        if (!SVC_READY) return;
        MDS.cmd("block", function (res) {
            var b = svcBlock(res);
            if (b > 0) CUR_BLOCK = b;
            processRenewals();
        });
    }
});

function ensureTable(cb) {
    // orderid is the PRIMARY KEY: exactly one in-flight renewal/edit per order. A concurrent auto-renewal
    // INSERT then fails harmlessly instead of creating a duplicate row that could re-place at the wrong
    // (old) price and discard a user edit.
    MDS.sql(
        "CREATE TABLE IF NOT EXISTS `gtc_renewals` (" +
        "  `orderid` varchar(160) NOT NULL PRIMARY KEY," +
        "  `oldcoinid` varchar(160) NOT NULL," +
        "  `lockamt` varchar(80) NOT NULL," +
        "  `locktok` varchar(80) NOT NULL," +
        "  `state` varchar(1024) NOT NULL," +
        "  `cancelposted` int NOT NULL," +   // 0 = intent written, cancel not yet posted; 1 = cancel on the wire
        "  `cancelblock` int NOT NULL," +     // block the cancel was posted (refund coin must be created >= this)
        "  `recreatesent` int NOT NULL," +
        "  `recreateblock` int NOT NULL," +
        "  `fundsmissing` int NOT NULL," +
        "  `retries` int NOT NULL," +
        "  `snapshot` varchar(512) NOT NULL" +
        ")", function () {
        // A manual X-cancel of a GTC order writes its orderId here so the engine ABORTS any renewal for
        // it instead of silently re-locking the funds the user asked to withdraw.
        MDS.sql(
            "CREATE TABLE IF NOT EXISTS `gtc_cancelled` (" +
            "  `orderid` varchar(160) NOT NULL PRIMARY KEY," +
            "  `block` int NOT NULL" +
            ")", function () { if (cb) cb(); });
    });
}

// Surface a user-actionable engine problem (e.g. keys LOCKED / no WRITE) into the shared activity log so
// the page shows it — otherwise a silently-not-renewing "never expires" order looks fine but isn't.
function svcAlert(msg, type) {
    MDS.sql("INSERT INTO activitylog (msg, type, timestamp) VALUES ('" + svcEsc(msg) + "','" + (type || "err") + "'," + Date.now() + ")");
}

function loadMyKeys(cb) {
    MDS.cmd("keys", function (res) {
        try {
            if (res && res.status && res.response) {
                var list = res.response.keys || res.response;
                if (Array.isArray(list)) for (var i = 0; i < list.length; i++) {
                    var pk = list[i].publickey || list[i];
                    if (pk && typeof pk === "string") MY_KEYS[pk] = true;
                }
            }
        } catch (e) { MDS.log("GTC svc keys error: " + e); }
        if (cb) cb();
    });
}

function svcBlock(res) {
    if (!res || !res.status || !res.response) return 0;
    var b = res.response.block;
    if ((b === undefined || b === "") && res.response.header) b = res.response.header.block;
    return parseInt(b) || 0;
}

function svcState(coin, port) {
    if (!coin.state) return "";
    for (var i = 0; i < coin.state.length; i++) if (coin.state[i].port === port) return coin.state[i].data;
    return "";
}

// Parse a V4 order coin into the fields the renewal engine needs (raw port strings preserved for
// byte-exact re-serialization).
function svcParseOrder(coin) {
    if (!coin.state || coin.state.length < 4) return null;
    var ownerkey = svcState(coin, 0);
    if (!ownerkey) return null;
    var sideNum = svcState(coin, 5);
    var isBuy = sideNum === "0";
    // Locked token + amount: SELL locks MINIMA (coin.amount, 0x00); BUY locks USDT (coin.tokenamount).
    var lockTok = coin.tokenid;
    var lockAmt = (isBuy && coin.tokenamount) ? coin.tokenamount : coin.amount;
    return {
        coinid: coin.coinid,
        ownerkey: ownerkey,
        p1: svcState(coin, 1), p2: svcState(coin, 2), p3: svcState(coin, 3),
        orderId: svcState(coin, 4), sideNum: sideNum, p6: svcState(coin, 6),
        gtc: svcState(coin, 7).trim() === "1",
        created: parseInt(coin.created) || 0,
        isMine: MY_KEYS[ownerkey] === true,
        lockAmt: lockAmt, lockTok: lockTok,
        priceNum: parseFloat(svcState(coin, 6)) || 0
    };
}

// Rebuild the order state verbatim + force GTC on (used for a renewal re-lock).
function svcGtcState(o) {
    return '{"0":"' + o.ownerkey + '","1":"' + o.p1 + '","2":"' + o.p2 + '","3":"' + o.p3 +
           '","4":"' + o.orderId + '","5":"' + o.sideNum + '","6":"' + o.p6 + '","7":"1"}';
}

function svcEsc(v) { return String(v).replace(/'/g, "''"); }

function processRenewals() {
    // Refresh the wallet key set periodically so a GTC order signed by a key created after the service
    // started is still recognised as mine (and thus renewed).
    if (CUR_BLOCK - LAST_KEYS_BLOCK >= KEYS_REFRESH_BLOCKS) { LAST_KEYS_BLOCK = CUR_BLOCK; loadMyKeys(function () {}); }

    MDS.cmd("coins address:" + SCRIPT_ADDR_V4, function (cres) {
        if (!cres.status || !Array.isArray(cres.response)) return;   // transport hiccup — wait next block
        var orders = [];
        var liveCoinids = {}, liveOrderIds = {};
        cres.response.forEach(function (c) {
            var o = svcParseOrder(c);
            if (!o) return;
            orders.push(o);
            liveCoinids[o.coinid] = true;
            liveOrderIds[o.orderId] = true;
        });
        pruneCancelled(function () {
            loadCancelled(function (cancelledOids) {
                MDS.sql("SELECT * FROM gtc_renewals", function (rres) {
                    var rows = (rres.status && rres.rows) ? rres.rows : [];
                    var pendingOids = {};
                    rows.forEach(function (row) { pendingOids[row.ORDERID] = true; });

                    // (1) Advance in-flight renewals/edits (post the cancel, then recreate once it mines).
                    rows.forEach(function (row) { advanceRow(row, liveCoinids, liveOrderIds, cancelledOids); });

                    // (2) Enqueue new auto-renewals for my due GTC orders not in flight / not user-cancelled.
                    var started = 0;
                    for (var i = 0; i < orders.length && started < MAX_RENEW_PER_BLOCK; i++) {
                        var o = orders[i];
                        if (o.isMine && o.gtc && (CUR_BLOCK - o.created) >= RENEW_AT &&
                            !pendingOids[o.orderId] && !cancelledOids[o.orderId]) {
                            started++;
                            pendingOids[o.orderId] = true;
                            enqueueRenewal(o);
                        }
                    }
                });
            });
        });
    });
}

function pruneCancelled(next) {
    MDS.sql("DELETE FROM gtc_cancelled WHERE block < " + (CUR_BLOCK - CANCELLED_PRUNE_BLOCKS), function () { next(); });
}

function loadCancelled(next) {
    MDS.sql("SELECT orderid FROM gtc_cancelled", function (xres) {
        var set = {};
        if (xres.status && xres.rows) xres.rows.forEach(function (r) { set[r.ORDERID] = true; });
        next(set);
    });
}

// Write a renewal INTENT row (cancel not yet posted). advanceRow posts the cancel next cycle. The
// state re-locks with GTC on and every other port byte-identical.
function enqueueRenewal(o) {
    var snap = JSON.stringify({ side: o.sideNum === "0" ? "buy" : "sell", price: o.priceNum,
                               minima: o.sideNum === "0" ? parseFloat(o.p2) : parseFloat(o.lockAmt) });
    var st = svcGtcState(o);
    MDS.sql("INSERT INTO gtc_renewals (orderid, oldcoinid, lockamt, locktok, state, cancelposted, cancelblock, recreatesent, recreateblock, fundsmissing, retries, snapshot) VALUES ('" +
        svcEsc(o.orderId) + "','" + svcEsc(o.coinid) + "','" + svcEsc(o.lockAmt) + "','" + svcEsc(o.lockTok) + "','" +
        svcEsc(st) + "',0,0,0,0,0,0,'" + svcEsc(snap) + "')");
}

function advanceRow(row, liveCoinids, liveOrderIds, cancelledOids) {
    var oid = row.ORDERID;
    if (BUSY[oid]) return;                                // a cancel/recreate post is already in flight

    // The user manually cancelled this GTC order — ABORT the renewal (never re-lock what they withdrew).
    // If the old coin is still live (cancel not yet mined) leave the coin alone; just drop our row so we
    // don't recreate. If the recreate ALREADY went out, this loses the race (rare) — but the user can
    // cancel the new coin; no funds are lost.
    if (cancelledOids[oid]) { MDS.sql("DELETE FROM gtc_renewals WHERE orderid='" + svcEsc(oid) + "'"); return; }

    // Phase A — post the cancel (owner-signed spend of the old coin back to the maker's wallet).
    if (parseInt(row.CANCELPOSTED) !== 1) {
        if (!liveCoinids[row.OLDCOINID]) {
            // Old coin already gone before we cancelled it → it was filled/spent. Mark cancelled + stamp the
            // block so Phase B only accepts a refund coin created at/after here (it won't be, for a fill).
            MDS.sql("UPDATE gtc_renewals SET cancelposted=1, cancelblock=" + CUR_BLOCK + " WHERE orderid='" + svcEsc(oid) + "'");
            return;
        }
        BUSY[oid] = true;
        var atBlock = CUR_BLOCK;
        postCancel(row, function (ok) {
            delete BUSY[oid];
            if (ok) MDS.sql("UPDATE gtc_renewals SET cancelposted=1, cancelblock=" + atBlock + " WHERE orderid='" + svcEsc(oid) + "'");
            else    MDS.sql("DELETE FROM gtc_renewals WHERE orderid='" + svcEsc(oid) + "'");   // hard fail → retry clean
        });
        return;
    }

    // Phase B — cancel posted; wait for it to leave the book, then recreate.
    if (liveCoinids[row.OLDCOINID]) return;               // cancel not mined yet — wait
    if (liveOrderIds[oid]) {                               // recreate landed (same orderId back) — done
        MDS.sql("DELETE FROM gtc_renewals WHERE orderid='" + svcEsc(oid) + "'");
        return;
    }

    var lockTok = (row.LOCKTOK && row.LOCKTOK !== "0x00") ? row.LOCKTOK : "0x00";

    // Phase B2 — a recreate was already sent. NEVER declare a fill here (we've committed the funds);
    // just wait for it to mine, and only re-post if it clearly didn't land after the wait window.
    if (parseInt(row.RECREATESENT) === 1) {
        if (parseInt(row.RECREATEBLOCK) > 0 && (CUR_BLOCK - parseInt(row.RECREATEBLOCK)) < RECREATE_WAIT_BLOCKS) return;
        BUSY[oid] = true;
        fundsBack(lockTok, row, function (back) {
            if (!back) { delete BUSY[oid]; return; }      // funds spent into the (still-pending) recreate — keep waiting
            resend(row, oid, lockTok);                    // send apparently failed but funds are back — retry
        });
        return;
    }

    // Phase B1 — first recreate attempt. Re-lock IF the cancel's exact refund is back as a FRESH plain
    // coin (created at/after the cancel). If NOT back, the order was FILLED (taker took it), never
    // cancelled — record the fill and drop the row; never re-lock.
    BUSY[oid] = true;
    fundsBack(lockTok, row, function (back) {
        if (!back) {
            delete BUSY[oid];
            var fm = parseInt(row.FUNDSMISSING) + 1;
            if (fm >= FUNDS_MISSING_GIVEUP) {
                recordSvcFill(row);
                MDS.sql("DELETE FROM gtc_renewals WHERE orderid='" + svcEsc(oid) + "'");
            } else {
                MDS.sql("UPDATE gtc_renewals SET fundsmissing=" + fm + " WHERE orderid='" + svcEsc(oid) + "'");
            }
            return;
        }
        resend(row, oid, lockTok);
    });
}

// Is the cancel's exact refund back as a PLAIN (stateless) wallet coin CREATED at/after the cancel block?
// The created>=cancelblock guard stops a coincidental same-size coin the maker already held from being
// mistaken for the refund (which would wrongly re-lock a filled order's would-be funds).
function fundsBack(lockTok, row, cb) {
    MDS.cmd("coins relevant:true sendable:true tokenid:" + lockTok, function (fres) {
        var back = false;
        var minBlock = parseInt(row.CANCELBLOCK) || 0;
        if (fres.status && Array.isArray(fres.response)) {
            for (var i = 0; i < fres.response.length; i++) {
                var c = fres.response[i];
                if (c.state && c.state.length > 0) continue;                 // plain wallet coins only
                if ((parseInt(c.created) || 0) < minBlock) continue;         // must be the fresh refund, not a stale coin
                var camt = (lockTok !== "0x00" && c.tokenamount) ? c.tokenamount : c.amount;
                if (Math.abs(parseFloat(camt) - parseFloat(row.LOCKAMT)) < 1e-9) { back = true; break; }
            }
        }
        cb(back);
    });
}

function resend(row, oid, lockTok) {
    var cmd = "send amount:" + row.LOCKAMT + " address:" + SCRIPT_ADDR_V4 + " state:" + row.STATE;
    if (lockTok !== "0x00") cmd += " tokenid:" + lockTok;
    var postedAt = CUR_BLOCK;
    MDS.cmd(cmd, function (sres) {
        delete BUSY[oid];
        if (sres && sres.status) {
            MDS.sql("UPDATE gtc_renewals SET recreatesent=1, recreateblock=" + postedAt + ", fundsmissing=0 WHERE orderid='" + svcEsc(oid) + "'");
            MDS.log("GTC re-locked order " + oid);
        } else {
            var rt = parseInt(row.RETRIES) + 1;
            if (rt > MAX_RECREATE_RETRIES) {
                MDS.log("GTC renewal stranded (funds safe in wallet) — order " + oid);
                svcAlert("Couldn't re-place a GTC order — its funds are safe in your wallet; re-create the order to put it back on the book.", "warn");
                MDS.sql("DELETE FROM gtc_renewals WHERE orderid='" + svcEsc(oid) + "'");
            } else {
                MDS.sql("UPDATE gtc_renewals SET retries=" + rt + ", recreatesent=0, recreateblock=0, fundsmissing=0 WHERE orderid='" + svcEsc(oid) + "'");
            }
        }
    });
}

// The owner-signed cancel: spend the order coin, pay the locked funds back to the maker's address
// (port 1) — the VERIFYOUT-compliant path. Mirrors lint.js cancelOrder. Amount/addr/token come from
// the persisted row so it works with no live coin object.
function postCancel(row, done) {
    var coinid = row.OLDCOINID;
    var lockTok = (row.LOCKTOK && row.LOCKTOK !== "0x00") ? row.LOCKTOK : "0x00";
    // wantAddr (port 1) is inside the persisted state JSON.
    var wantAddr = "";
    try { wantAddr = JSON.parse(row.STATE)["1"]; } catch (e) {}
    var ownerkey = "";
    try { ownerkey = JSON.parse(row.STATE)["0"]; } catch (e) {}
    if (!wantAddr || !ownerkey) { if (done) done(false); return; }
    var txid = "gtcrenew_" + coinid.substring(0, 18) + "_" + CUR_BLOCK;
    MDS.cmd("txncreate id:" + txid, function (r0) {
        if (!r0.status) return finishCancel(txid, false, done);
        MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function (r1) {
            if (!r1.status) return finishCancel(txid, false, done);   // coin gone (filled) — drop, retry clean
            var outCmd = "txnoutput id:" + txid + " amount:" + row.LOCKAMT + " address:" + wantAddr + " storestate:false";
            if (lockTok !== "0x00") outCmd += " tokenid:" + lockTok;
            MDS.cmd(outCmd, function (r2) {
                if (!r2.status) return finishCancel(txid, false, done);
                MDS.cmd("txnsign id:" + txid + " publickey:" + ownerkey, function (rs) {
                    if (!rs || !rs.status) {
                        var serr = rs && rs.error ? String(rs.error) : "unknown";
                        MDS.log("GTC cancel sign failed: " + serr);
                        // Vault locked / no WRITE → tell the user; their GTC orders aren't being kept alive.
                        if (serr.toUpperCase().indexOf("LOCK") >= 0)
                            svcAlert("GTC auto-renew blocked — node vault is LOCKED. Unlock it to keep your good-till-cancelled orders alive.", "err");
                        return finishCancel(txid, false, done);
                    }
                    MDS.cmd("txnbasics id:" + txid, function (rb) {
                        if (!rb || !rb.status) return finishCancel(txid, false, done);
                        MDS.cmd("txnpost id:" + txid, function (rp) {
                            MDS.cmd("txndelete id:" + txid, function () {});
                            if (done) done(!!(rp && rp.status));
                        });
                    });
                });
            });
        });
    });
}
function finishCancel(txid, ok, done) { MDS.cmd("txndelete id:" + txid, function () {}); if (done) done(ok); }

// Record a maker fill that the renewal machinery suppressed (order taken mid-renewal), so it still
// shows in History. Mirrors lint.js recordMyTrade shape into the `mytrades` table.
function recordSvcFill(row) {
    var s;
    try { s = JSON.parse(row.SNAPSHOT); } catch (e) { return; }
    var total = (parseFloat(s.minima) * parseFloat(s.price)).toFixed(4);
    var now = Date.now();
    MDS.sql("INSERT INTO mytrades (orderid, role, side, price, amount, total, gecko_price, block, timestamp) VALUES ('" +
        svcEsc(row.ORDERID) + "','maker','" + svcEsc(s.side) + "','" + svcEsc(s.price) + "','" +
        svcEsc(parseFloat(s.minima).toFixed(4)) + "','" + svcEsc(total) + "','0'," + CUR_BLOCK + "," + now + ")");
    MDS.log("GTC: recorded maker fill during renewal — order " + row.ORDERID);
}
