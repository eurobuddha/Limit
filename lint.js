/**
 * Limit v0.5.0 — On-Chain Limit Order DEX for MINIMA/USDT
 * Uses official Minima VERIFYOUT exchange contract pattern
 * FULL FILL ONLY — no partial fills
 *
 * KISS VM Smart Contracts:
 *   V1 (legacy, no expiry):
 *     IF SIGNEDBY(PREVSTATE(0)) THEN RETURN TRUE ENDIF
 *     ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE)
 *     RETURN TRUE
 *   V2 (current, 1500 block expiry):
 *     IF SIGNEDBY(PREVSTATE(0)) THEN RETURN TRUE ENDIF
 *     IF @COINAGE GT 1500 THEN ASSERT VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) RETURN TRUE ENDIF
 *     ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE)
 *     RETURN TRUE
 *
 * State layout:
 *   Port 0 = owner public key (for SIGNEDBY cancel)
 *   Port 1 = want address (where owner receives payment)
 *   Port 2 = want amount (exact amount owner wants)
 *   Port 3 = want tokenid (token owner wants)
 *   Port 4 = order ID (hex timestamp)
 *   Port 5 = side (0=buy, 1=sell)
 *   Port 6 = price (display only, not used by contract)
 *
 * CANCEL: txnsign publickey:OWNERKEY (pending on restricted MDS) → auto-complete txnbasics+txnpost on NEWBLOCK
 * FILL: txnsign publickey:auto (pending on restricted MDS) → auto-complete txnbasics+txnpost on NEWBLOCK
 */

var SCRIPT_V1 = 'IF SIGNEDBY(PREVSTATE(0)) THEN RETURN TRUE ENDIF ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE) RETURN TRUE';
var SCRIPT_V2 = 'IF SIGNEDBY(PREVSTATE(0)) THEN RETURN TRUE ENDIF IF @COINAGE GT 1500 THEN ASSERT VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) RETURN TRUE ENDIF ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE) RETURN TRUE';
var USDT_ID = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
var SCRIPT_ADDR_V1 = "0x131609A5E510326354647E240F51C53825EFF8CA2B9DE07711EA56055E57672D";
var SCRIPT_ADDR_V2 = "0xE4D3F27BB044500AF56EF775DAFF3A12187EE79A8460FBBBF321F76A660D7797";
var SCRIPTS_REGISTERED = false;
var DB_READY = false;
var MY_ADDR = "";
var MY_HEX_ADDR = "";
var MY_PUBKEY = "";
var ORDERS = [];
var FILLS = [];
var MY_KEYS = {};              // all wallet pubkeys {key: true} for isMine check
var ORDER_SIDE = "sell";
var FILL_IN_PROGRESS = false;
var GECKO_PRICE = null;
var PENDING_TXID = null;       // txid awaiting pending approval
var PENDING_CALLBACK = null;   // callback to run after fill completes
var CANCEL_STATUS = {};        // coinid → "pending"|"confirming"|"confirmed"
var PREV_ORDER_COUNT = -1;     // track order book changes
var CURRENT_BLOCK = 0;         // latest block height for age display
var PREV_MINIMA_BAL = null;    // track balance changes
var PREV_USDT_BAL = null;
var PENDING_FILL_COINID = null; // coinid of order being filled — watch for removal
var PENDING_CREATE = false;    // true after order send — watch for new mine order to appear
var MY_TRADES = [];            // personal trading history from SQL
var PREV_MY_ORDERS = {};       // track mine orders for maker fill detection
var EXPIRED_ORDERS = [];       // V2 orders past 1500 blocks — pending collection

// -- Init --
MDS.init(function(msg) {
    if (msg.event === "inited") initApp();
    if (msg.event === "NEWBLOCK") {
        updateBlock(msg);
        if (DB_READY) { refreshOrders(); refreshBalances(); }
        if (PENDING_TXID) checkPendingComplete();
    }
    if (msg.event === "NEWBALANCE") {
        if (DB_READY) { refreshOrders(); refreshBalances(); clearPendingStatus(); }
    }
});

function initApp() {
    // Addresses are hardcoded — skip newscript on startup (avoids pending prompts)
    // Register scripts lazily in background after 3 seconds
    MDS.log("Limit v0.5.0 contracts: V1=" + SCRIPT_ADDR_V1 + " V2=" + SCRIPT_ADDR_V2);
    loadIdentity(function() { finishInit(); });
    setTimeout(registerScripts, 3000);
    MDS.cmd("block", function(res) {
        if (res.status) document.getElementById("blockHeight").innerText = "#" + res.response.block;
    });
    setupUI();
    fetchGeckoPrice();
    setInterval(fetchGeckoPrice, 60000);
    window.addEventListener('beforeunload', function() {
        if (SCRIPTS_REGISTERED) {
            MDS.cmd('newscript script:"' + SCRIPT_V1 + '" track:false');
            MDS.cmd('newscript script:"' + SCRIPT_V2 + '" track:false');
        }
    });
}

function registerScripts() {
    if (SCRIPTS_REGISTERED) return;
    MDS.cmd('newscript script:"' + SCRIPT_V1 + '" trackall:true', function() {
        MDS.cmd('newscript script:"' + SCRIPT_V2 + '" trackall:true', function() {
            SCRIPTS_REGISTERED = true;
            MDS.log("Scripts registered with trackall:true");
        });
    });
}

function ensureRegistered(callback) {
    if (SCRIPTS_REGISTERED) { callback(); return; }
    MDS.cmd('newscript script:"' + SCRIPT_V1 + '" trackall:true', function() {
        MDS.cmd('newscript script:"' + SCRIPT_V2 + '" trackall:true', function() {
            SCRIPTS_REGISTERED = true;
            callback();
        });
    });
}

function loadIdentity(callback) {
    try {
        var sp = localStorage.getItem("limit_pubkey");
        var sh = localStorage.getItem("limit_hexaddr");
        var sm = localStorage.getItem("limit_miniaddr");
        if (sp && sh) { MY_PUBKEY = sp; MY_HEX_ADDR = sh; MY_ADDR = sm || sh; callback(); return; }
    } catch(e) {}
    MDS.keypair.get("limit_pubkey", function(kres) {
        if (kres.status && kres.value && kres.value.length > 10) {
            MY_PUBKEY = kres.value;
            MDS.keypair.get("limit_hexaddr", function(k2) {
                MY_HEX_ADDR = (k2.status && k2.value) ? k2.value : "";
                MDS.keypair.get("limit_miniaddr", function(k3) {
                    MY_ADDR = (k3.status && k3.value) ? k3.value : MY_HEX_ADDR;
                    if (MY_PUBKEY && MY_HEX_ADDR) { callback(); return; }
                    fetchAndStoreIdentity(callback);
                });
            });
            return;
        }
        fetchAndStoreIdentity(callback);
    });
}

function fetchAndStoreIdentity(callback) {
    MDS.cmd("getaddress", function(res) {
        if (!res.status) { callback(); return; }
        MY_PUBKEY = res.response.publickey;
        MY_HEX_ADDR = res.response.address;
        MY_ADDR = res.response.miniaddress;
        try { localStorage.setItem("limit_pubkey", MY_PUBKEY); localStorage.setItem("limit_hexaddr", MY_HEX_ADDR); localStorage.setItem("limit_miniaddr", MY_ADDR); } catch(e) {}
        MDS.keypair.set("limit_pubkey", MY_PUBKEY, function() {
            MDS.keypair.set("limit_hexaddr", MY_HEX_ADDR, function() {
                MDS.keypair.set("limit_miniaddr", MY_ADDR, function() { callback(); });
            });
        });
    });
}

function loadWalletKeys(callback) {
    MDS.cmd("keys", function(res) {
        MDS.log("Keys cmd status=" + (res ? res.status : "null"));
        try {
            if (res && res.status && res.response) {
                var resp = res.response;
                var list = resp.keys || resp;
                if (Array.isArray(list)) {
                    for (var i = 0; i < list.length; i++) {
                        var pk = list[i].publickey || list[i];
                        if (pk && typeof pk === 'string') MY_KEYS[pk] = true;
                    }
                }
            }
        } catch(e) { MDS.log("Keys error: " + e); }
        if (MY_PUBKEY) MY_KEYS[MY_PUBKEY] = true;
        MDS.log("Wallet keys loaded: " + Object.keys(MY_KEYS).length);
        if (callback) callback();
    });
}

function isMyKey(pubkey) {
    return MY_KEYS[pubkey] === true;
}

function finishInit() {
    loadWalletKeys(function() {
        // Check if tables exist with a read — only CREATE if needed (avoids pending prompts)
        MDS.sql("SELECT 1 FROM fills LIMIT 1", function(fcheck) {
            var tablesExist = fcheck.status;
            if (tablesExist) {
                // Tables already exist — skip creation, go straight to ready
                onTablesReady();
            } else {
                // First run — create tables (will trigger pending on restricted MDS)
                createTables(function() { onTablesReady(); });
            }
        });
    });
}

function createTables(callback) {
    MDS.sql(
        "CREATE TABLE IF NOT EXISTS `fills` (" +
        "  `id` bigint auto_increment," +
        "  `orderid` varchar(160) NOT NULL," +
        "  `side` varchar(10) NOT NULL," +
        "  `price` varchar(80) NOT NULL," +
        "  `amount` varchar(80) NOT NULL," +
        "  `total` varchar(80) NOT NULL," +
        "  `block` int NOT NULL," +
        "  `timestamp` bigint NOT NULL" +
        ")", function() {
        MDS.sql(
            "CREATE TABLE IF NOT EXISTS `activitylog` (" +
            "  `id` bigint auto_increment," +
            "  `msg` varchar(512) NOT NULL," +
            "  `type` varchar(10) NOT NULL," +
            "  `timestamp` bigint NOT NULL" +
            ")", function() {
            MDS.sql(
                "CREATE TABLE IF NOT EXISTS `mytrades` (" +
                "  `id` bigint auto_increment," +
                "  `orderid` varchar(160) NOT NULL," +
                "  `role` varchar(10) NOT NULL," +
                "  `side` varchar(10) NOT NULL," +
                "  `price` varchar(80) NOT NULL," +
                "  `amount` varchar(80) NOT NULL," +
                "  `total` varchar(80) NOT NULL," +
                "  `gecko_price` varchar(80) NOT NULL," +
                "  `block` int NOT NULL," +
                "  `timestamp` bigint NOT NULL" +
                ")", function() { if (callback) callback(); });
        });
    });
}

function onTablesReady() {
    DB_READY = true;
    MDS.log("Limit v0.5.0 ready. V1=" + SCRIPT_ADDR_V1 + " V2=" + SCRIPT_ADDR_V2 + " Keys=" + Object.keys(MY_KEYS).length);
    backfillMyTrades(function() {
        loadActivityLog(function() {
            logActivity("DEX ready — " + Object.keys(MY_KEYS).length + " keys loaded", "info");
            logActivity("Remember: press EXIT when done to clear tracked coins from your wallet", "warn");
            refreshOrders(); refreshBalances(); loadFills(); loadMyTrades();
            setTimeout(cleanupZombieTxns, 5000);
        });
    });
}

function cleanupZombieTxns() {
    MDS.cmd("txnlist", function(res) {
        if (!res.status || !res.response) return;
        res.response.forEach(function(tx) {
            if (tx.id && (tx.id.indexOf("fill_") === 0 || tx.id.indexOf("cancel_") === 0 || tx.id.indexOf("collect_") === 0 || tx.id.indexOf("refresh_") === 0)) {
                MDS.cmd("txndelete id:" + tx.id);
                logActivity("Cleaned up stuck txn: " + tx.id, "warn");
            }
        });
    });
}

// Auto-collect expired orders from EXPIRED_ORDERS (populated by refreshOrders filter)
function autoCollectExpired() {
    if (!EXPIRED_ORDERS || EXPIRED_ORDERS.length === 0) return;
    EXPIRED_ORDERS.forEach(function(c) {
        // Skip if already being collected
        if (CANCEL_STATUS[c.coinid]) return;
        var ownerAddr = "";
        var amt = c.tokenamount || c.amount;
        for (var i = 0; i < (c.state || []).length; i++) {
            if (c.state[i].port === 1) ownerAddr = c.state[i].data;
        }
        if (!ownerAddr) return;
        logActivity("Collecting expired order — " + parseFloat(amt).toFixed(4) + " back to owner", "warn");
        CANCEL_STATUS[c.coinid] = "collecting";
        var txid = "collect_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6);
        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { logActivity("Collect failed — txncreate", "err"); delete CANCEL_STATUS[c.coinid]; return; }
            MDS.cmd("txninput id:" + txid + " coinid:" + c.coinid, function(r1) {
                if (!r1.status) { logActivity("Collect failed — txninput", "err"); MDS.cmd("txndelete id:" + txid); delete CANCEL_STATUS[c.coinid]; return; }
                var outCmd = "txnoutput id:" + txid + " amount:" + amt + " address:" + ownerAddr + " storestate:false";
                if (c.tokenid !== "0x00") outCmd += " tokenid:" + c.tokenid;
                MDS.cmd(outCmd, function(r2) {
                    if (!r2.status) { logActivity("Collect failed — txnoutput", "err"); MDS.cmd("txndelete id:" + txid); delete CANCEL_STATUS[c.coinid]; return; }
                    // COINAGE path needs no signature — post directly
                    MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function(pr) {
                        var rp = Array.isArray(pr) ? pr[pr.length - 1] : pr;
                        if (rp && rp.status) {
                            logActivity("Expired order collected — funds returning to owner", "ok");
                        } else {
                            logActivity("Collect failed — " + (rp ? rp.error || "unknown" : "no response"), "err");
                            MDS.cmd("txndelete id:" + txid);
                            delete CANCEL_STATUS[c.coinid];
                        }
                    });
                });
            });
        });
    });
}

// -- My Trades --
function recordMyTrade(orderId, role, side, price, amount) {
    var total = (parseFloat(amount) * parseFloat(price)).toFixed(4);
    var gp = GECKO_PRICE ? GECKO_PRICE.toFixed(6) : "0";
    var now = Date.now();
    MDS.cmd("block", function(res) {
        var bn = res.status ? parseInt(res.response.block) || 0 : 0;
        MDS.sql(
            "INSERT INTO mytrades (orderid, role, side, price, amount, total, gecko_price, block, timestamp) VALUES ('" +
            sqlEsc(orderId) + "', '" + sqlEsc(role) + "', '" + sqlEsc(side) + "', '" + sqlEsc(price) + "', '" +
            sqlEsc(amount) + "', '" + sqlEsc(total) + "', '" + sqlEsc(gp) + "', " + bn + ", " + now + ")",
            function() { loadMyTrades(); }
        );
    });
}

function loadMyTrades(callback) {
    MDS.sql("SELECT * FROM mytrades ORDER BY timestamp DESC LIMIT 200", function(res) {
        if (!res.status) { if (callback) callback(); return; }
        MY_TRADES = res.rows || [];
        renderMyTrades();
        if (callback) callback();
    });
}

function renderMyTrades() {
    var el = document.getElementById("myTradesList");
    if (!el) return;
    if (MY_TRADES.length === 0) {
        el.innerHTML = '<div class="book__empty">No personal trades yet</div>';
        renderTradeStats();
        return;
    }
    var html = "";
    MY_TRADES.forEach(function(t) {
        var d = new Date(parseInt(t.TIMESTAMP));
        var date = ('0'+d.getDate()).slice(-2)+'/'+('0'+(d.getMonth()+1)).slice(-2)+' '+
                   ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
        var sideClass = t.SIDE === "buy" ? "side-tag--buy" : "side-tag--sell";
        var gp = parseFloat(t.GECKO_PRICE);
        var gpStr = gp > 0 ? fmtPrice(gp) : "—";
        html += '<div class="mytrades__row">' +
            '<span>' + date + '</span>' +
            '<span class="side-tag ' + sideClass + '">' + t.SIDE.toUpperCase() + '</span>' +
            '<span>' + parseFloat(t.AMOUNT).toFixed(4) + '</span>' +
            '<span class="price--' + t.SIDE + '">' + fmtPrice(parseFloat(t.PRICE)) + '</span>' +
            '<span>' + parseFloat(t.TOTAL).toFixed(4) + '</span>' +
            '<span>' + gpStr + '</span>' +
            '<span>' + t.BLOCK + '</span></div>';
    });
    el.innerHTML = html;
    renderTradeStats();
}

function renderTradeStats() {
    var count = MY_TRADES.length;
    var el = document.getElementById("statTrades");
    if (!el) return;
    el.innerText = count;
    if (count === 0) {
        document.getElementById("statVolume").innerText = "0.00";
        document.getElementById("statAvgPrice").innerText = "—";
        document.getElementById("statPnL").innerText = "—";
        return;
    }
    var totalVol = 0, weightedPrice = 0, totalAmt = 0, pnl = 0;
    MY_TRADES.forEach(function(t) {
        var total = parseFloat(t.TOTAL);
        var price = parseFloat(t.PRICE);
        var amount = parseFloat(t.AMOUNT);
        var gecko = parseFloat(t.GECKO_PRICE);
        totalVol += total;
        weightedPrice += price * amount;
        totalAmt += amount;
        if (gecko > 0) {
            pnl += t.SIDE === "buy" ? (gecko - price) * amount : (price - gecko) * amount;
        }
    });
    var avgPrice = totalAmt > 0 ? weightedPrice / totalAmt : 0;
    document.getElementById("statVolume").innerText = totalVol.toFixed(2);
    document.getElementById("statAvgPrice").innerText = fmtPrice(avgPrice);
    var pnlEl = document.getElementById("statPnL");
    pnlEl.innerText = (pnl >= 0 ? "+" : "") + pnl.toFixed(4) + " USDT";
    pnlEl.style.color = pnl >= 0 ? "var(--green)" : "var(--red)";
}

function backfillMyTrades(callback) {
    MDS.sql("SELECT COUNT(*) AS C FROM mytrades", function(res) {
        if (res.status && res.rows && parseInt(res.rows[0].C) === 0) {
            MDS.sql("SELECT COUNT(*) AS C FROM fills", function(fres) {
                if (fres.status && fres.rows && parseInt(fres.rows[0].C) > 0) {
                    MDS.sql("INSERT INTO mytrades (orderid, role, side, price, amount, total, gecko_price, block, timestamp) " +
                        "SELECT orderid, 'taker', side, price, amount, total, '0', block, timestamp FROM fills",
                        function() { if (callback) callback(); });
                } else { if (callback) callback(); }
            });
        } else { if (callback) callback(); }
    });
}

// -- Activity Log --
function logActivity(msg, type) {
    var el = document.getElementById("activityLog");
    if (!el) return;
    var now = Date.now();
    var t = new Date(now);
    var ts = ('0'+t.getHours()).slice(-2)+':'+('0'+t.getMinutes()).slice(-2)+':'+('0'+t.getSeconds()).slice(-2);
    var cls = type==='ok'?'log--ok':type==='warn'?'log--warn':type==='err'?'log--err':'log--info';
    el.innerHTML = '<div class="log-entry"><span class="log-time">'+ts+'</span><span class="log-msg '+cls+'">'+msg+'</span></div>' + el.innerHTML;
    while (el.children.length > 100) el.removeChild(el.lastChild);
    // Persist to SQL
    if (DB_READY) MDS.sql("INSERT INTO activitylog (msg, type, timestamp) VALUES ('" + sqlEsc(msg) + "', '" + sqlEsc(type) + "', " + now + ")");
}

function loadActivityLog(callback) {
    MDS.sql("SELECT * FROM activitylog ORDER BY timestamp DESC LIMIT 100", function(res) {
        if (!res.status || !res.rows || res.rows.length === 0) { if (callback) callback(); return; }
        var el = document.getElementById("activityLog");
        if (!el) { if (callback) callback(); return; }
        var html = "";
        res.rows.forEach(function(row) {
            var t = new Date(parseInt(row.TIMESTAMP));
            var day = ('0'+t.getDate()).slice(-2)+'/'+('0'+(t.getMonth()+1)).slice(-2);
            var ts = day+' '+('0'+t.getHours()).slice(-2)+':'+('0'+t.getMinutes()).slice(-2)+':'+('0'+t.getSeconds()).slice(-2);
            var cls = row.TYPE==='ok'?'log--ok':row.TYPE==='warn'?'log--warn':row.TYPE==='err'?'log--err':'log--info';
            html += '<div class="log-entry"><span class="log-time">'+ts+'</span><span class="log-msg '+cls+'">'+row.MSG+'</span></div>';
        });
        el.innerHTML = html;
        if (callback) callback();
    });
}

// -- Helpers --
function fmtPrice(p) { return p < 0.01 ? p.toFixed(6) : p < 1 ? p.toFixed(5) : p.toFixed(4); }
function sqlEsc(v) { return String(v).replace(/'/g, "''"); }
function isPending(res) {
    if (!res) return false;
    if (res.pending === true) return true;
    // Restricted MDS returns {status:false, error:"...pending.."} instead of {pending:true}
    if (res.status === false && res.error && String(res.error).toLowerCase().indexOf("pending") >= 0) return true;
    return false;
}

function showPending(el, msg, txid, onComplete) {
    if (el) { el.className = "status status--warn"; el.innerText = msg || "Approve in Pending Actions..."; }
    FILL_IN_PROGRESS = false;
    // Store txid for auto-completion after pending approval
    if (txid) {
        PENDING_TXID = txid;
        PENDING_CALLBACK = onComplete || null;
        MDS.log("PENDING: waiting for approval of " + txid);
    }
}

// Called on NEWBLOCK — check if pending txnsign was approved, then complete with txnbasics+txnpost
function checkPendingComplete() {
    if (!PENDING_TXID) return;
    var txid = PENDING_TXID;
    MDS.cmd("txnlist", function(res) {
        if (!res.status || !res.response) return;
        var found = null;
        for (var i = 0; i < res.response.length; i++) {
            if (res.response[i].id === txid) { found = res.response[i]; break; }
        }
        if (!found) { PENDING_TXID = null; PENDING_CALLBACK = null; return; } // tx gone (deleted or expired)
        // Check if signatures are populated (pending was approved)
        var sigs = found.witness && found.witness.signatures;
        if (!sigs || sigs.length === 0) return; // not yet approved, wait for next block
        var hasSigs = sigs[0] && sigs[0].signatures && sigs[0].signatures.length > 0;
        if (!hasSigs) return;
        // Check if mmrproofs already populated (already completed)
        var proofs = found.witness.mmrproofs;
        if (proofs && proofs.length > 0) return; // already done
        // Signatures present, proofs missing — complete the transaction!
        MDS.log("PENDING APPROVED: completing " + txid + " with txnbasics+txnpost");
        // Mark any cancel as confirming
        for (var cid in CANCEL_STATUS) { if (CANCEL_STATUS[cid] === "pending") CANCEL_STATUS[cid] = "confirming"; }
        renderMyOrders();
        var csEl = document.getElementById("cancelStatus");
        if (csEl) { csEl.className = "status status--warn"; csEl.innerText = "Confirming cancellation..."; }
        var cb = PENDING_CALLBACK;
        PENDING_TXID = null;
        PENDING_CALLBACK = null;
        MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function(resArr) {
            var rp = Array.isArray(resArr) ? resArr[resArr.length - 1] : resArr;
            MDS.log("AUTO-COMPLETE: status=" + (rp ? rp.status : "null") + " err=" + (rp ? rp.error || "none" : "no response"));
            if (rp && rp.status) {
                MDS.notify("Transaction completed!");
                if (cb) cb(true);
                refreshOrders(); refreshBalances();
            } else {
                MDS.log("AUTO-COMPLETE FAILED: " + (rp ? rp.error || "unknown" : "no response"));
                if (cb) cb(false);
            }
        });
    });
}

function showErr(el, msg, txid) {
    if (el) { el.className = "status status--err"; el.innerText = msg; }
    if (txid) MDS.cmd("txndelete id:" + txid);
    FILL_IN_PROGRESS = false;
    MDS.log("ERROR: " + msg);
}

function showOk(el, msg) {
    if (el) { el.className = "status status--ok"; el.innerText = msg; }
}

function clearPendingStatus() {
    var els = document.querySelectorAll(".status--warn");
    for (var i = 0; i < els.length; i++) {
        els[i].className = "status status--ok"; els[i].innerText = "Confirmed!";
        (function(el) { setTimeout(function() { el.innerText = ""; el.className = "status"; }, 4000); })(els[i]);
    }
}

function refreshBalances() {
    MDS.cmd("balance", function(res) {
        if (!res.status) return;
        var minBal = "0", usdtBal = "0";
        (res.response || []).forEach(function(b) {
            if (b.tokenid === "0x00") minBal = b.sendable;
            if (b.tokenid === USDT_ID) usdtBal = b.sendable;
        });
        var newMin = parseFloat(minBal), newUsdt = parseFloat(usdtBal);
        if (PREV_MINIMA_BAL !== null) {
            var minDiff = newMin - PREV_MINIMA_BAL;
            var usdtDiff = newUsdt - PREV_USDT_BAL;
            if (Math.abs(minDiff) > 0.001) logActivity("Balance: " + (minDiff > 0 ? "+" : "") + minDiff.toFixed(2) + " MINIMA → " + newMin.toFixed(2), minDiff > 0 ? "ok" : "warn");
            if (Math.abs(usdtDiff) > 0.001) logActivity("Balance: " + (usdtDiff > 0 ? "+" : "") + usdtDiff.toFixed(4) + " USDT → " + newUsdt.toFixed(4), usdtDiff > 0 ? "ok" : "warn");
        }
        PREV_MINIMA_BAL = newMin;
        PREV_USDT_BAL = newUsdt;
        document.getElementById("minimaBalance").innerText = newMin.toFixed(2) + " MINIMA";
        document.getElementById("usdtBalance").innerText = newUsdt.toFixed(2) + " USDT";
    });
}

function updateBlock(msg) {
    document.getElementById("blockHeight").innerText = "#" + parseInt(msg.data.txpow.header.block);
}

// -- CoinGecko Price --
function parseNetResponse(res) {
    var raw = res.response || res;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch(e) { return null; }
}

function fetchGeckoPrice() {
    MDS.net.GET("https://api.coingecko.com/api/v3/simple/price?ids=minima&vs_currencies=usd&include_24hr_change=true", function(res) {
        try {
            var data = parseNetResponse(res);
            if (data && data.minima) {
                GECKO_PRICE = data.minima.usd;
                var change = data.minima.usd_24h_change || 0;
                var priceEl = document.getElementById("geckoPrice");
                if (priceEl) {
                    var sign = change >= 0 ? "+" : "";
                    priceEl.innerText = "$" + GECKO_PRICE.toFixed(6) + " (" + sign + change.toFixed(1) + "%)";
                    priceEl.className = change >= 0 ? "hdr__bal status--ok" : "hdr__bal status--err";
                }
            }
        } catch(e) { MDS.log("Gecko price error: " + e); }
    });
}

function fetchGeckoChart(callback) {
    MDS.net.GET("https://api.coingecko.com/api/v3/coins/minima/market_chart?vs_currency=usd&days=7", function(res) {
        try {
            var data = parseNetResponse(res);
            callback(data);
        } catch(e) { callback(null); }
    });
}

// -- UI Setup --
function setupUI() {
    document.querySelectorAll(".tab").forEach(function(tab) {
        tab.addEventListener("click", function() {
            document.querySelectorAll(".tab").forEach(function(t) { t.classList.remove("tab--active"); });
            document.querySelectorAll(".view").forEach(function(v) { v.classList.remove("view--active"); });
            tab.classList.add("tab--active");
            document.getElementById("view-" + tab.dataset.view).classList.add("view--active");
            if (tab.dataset.view === "chart") renderCharts();
            if (tab.dataset.view === "history") loadMyTrades();
        });
    });
    document.querySelectorAll(".side-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            document.querySelectorAll(".side-btn").forEach(function(b) { b.classList.remove("side-btn--active"); });
            btn.classList.add("side-btn--active");
            ORDER_SIDE = btn.dataset.side;
            updateCreateForm();
        });
    });
    document.getElementById("btnCreate").addEventListener("click", createOrder);
    document.getElementById("orderPrice").addEventListener("input", updateSummary);
    document.getElementById("orderAmount").addEventListener("input", updateSummary);
    document.getElementById("fillAmount").addEventListener("input", updateFillCost);
    document.getElementById("btnFill").addEventListener("click", executeFill);
    document.getElementById("btnCancelFill").addEventListener("click", function() {
        document.getElementById("fillPanel").style.display = "none";
    });
    updateCreateForm();
}

function updateCreateForm() {
    var btn = document.getElementById("btnCreate");
    var label = document.getElementById("summaryLabel");
    var amtLabel = document.getElementById("orderAmountLabel");
    if (ORDER_SIDE === "buy") {
        btn.className = "btn btn--buy btn--full"; btn.innerText = "Place Buy Order";
        label.innerText = "Total USDT to lock:"; amtLabel.innerText = "Amount of Minima to buy";
    } else {
        btn.className = "btn btn--sell btn--full"; btn.innerText = "Place Sell Order";
        label.innerText = "Total Minima to lock:"; amtLabel.innerText = "Amount of Minima to sell";
    }
    updateSummary();
}

function updateSummary() {
    var amt = parseFloat(document.getElementById("orderAmount").value) || 0;
    var price = parseFloat(document.getElementById("orderPrice").value) || 0;
    document.getElementById("totalSummary").innerText = ORDER_SIDE === "buy" ? (amt * price).toFixed(4) + " USDT" : amt.toFixed(4) + " MINIMA";
}

// -- Order Book --
function refreshOrders() {
    if (!SCRIPT_ADDR_V1 && !SCRIPT_ADDR_V2) return;
    var allCoins = [];
    var done = 0, total = (SCRIPT_ADDR_V1 ? 1 : 0) + (SCRIPT_ADDR_V2 ? 1 : 0);
    function onAllCoins() {
        done++;
        if (done < total) return;
        // Get current block to filter expired V2 orders
        MDS.cmd("block", function(bres) {
            var curBlock = (bres && bres.status) ? parseInt(bres.response.block) : 0;
            CURRENT_BLOCK = curBlock;
            // Separate live orders from expired V2 orders
            var liveCoins = [];
            EXPIRED_ORDERS = [];
            allCoins.forEach(function(c) {
                if (c.address === SCRIPT_ADDR_V2 && curBlock > 0) {
                    var age = curBlock - (parseInt(c.created) || 0);
                    if (age > 1500) {
                        EXPIRED_ORDERS.push(c);
                        return;
                    }
                }
                liveCoins.push(c);
            });
            if (EXPIRED_ORDERS.length > 0) {
                MDS.log("Expired orders filtered: " + EXPIRED_ORDERS.length + " (live: " + liveCoins.length + ")");
            }
            MDS.log("Order coins: " + liveCoins.length);
            // Check if a pending fill has been confirmed on-chain
            if (PENDING_FILL_COINID) {
                var stillExists = false;
                for (var i = 0; i < allCoins.length; i++) {
                    if (allCoins[i].coinid === PENDING_FILL_COINID) { stillExists = true; break; }
                }
                if (!stillExists) {
                    logActivity("Order confirmed on-chain — removed from book", "ok");
                    logActivity("Waiting for balance update...", "info");
                    PENDING_FILL_COINID = null;
                }
            }
            // Check if a pending order creation has been confirmed on-chain
            if (PENDING_CREATE && PREV_ORDER_COUNT >= 0 && liveCoins.length > PREV_ORDER_COUNT) {
                PENDING_CREATE = false;
                logActivity("Order confirmed on-chain!", "ok");
                logActivity("Order expires in ~1500 blocks (~23h) unless refreshed", "warn");
                logActivity("Waiting for balance update...", "info");
                var csEl = document.getElementById("createStatus");
                if (csEl) { csEl.className = "status status--ok"; csEl.innerText = "Order confirmed — expires in ~23h unless refreshed"; setTimeout(function() { csEl.innerText = ""; csEl.className = "status"; }, 8000); }
            }
            // Log order book changes
            if (PREV_ORDER_COUNT >= 0 && liveCoins.length !== PREV_ORDER_COUNT) {
                var diff = liveCoins.length - PREV_ORDER_COUNT;
                logActivity("Order book: " + liveCoins.length + " orders (" + (diff > 0 ? "+" : "") + diff + ")", "info");
            }
            PREV_ORDER_COUNT = liveCoins.length;
            parseOrderCoins(liveCoins);
            autoCollectExpired();
        });
    }
    if (SCRIPT_ADDR_V1) {
        MDS.cmd("coins address:" + SCRIPT_ADDR_V1, function(res) {
            if (res.status && res.response) allCoins = allCoins.concat(res.response);
            onAllCoins();
        });
    }
    if (SCRIPT_ADDR_V2) {
        MDS.cmd("coins address:" + SCRIPT_ADDR_V2, function(res) {
            if (res.status && res.response) allCoins = allCoins.concat(res.response);
            onAllCoins();
        });
    }
}

function exitDex() {
    // Stop future tracking
    MDS.cmd('newscript script:"' + SCRIPT_V1 + '" track:false');
    MDS.cmd('newscript script:"' + SCRIPT_V2 + '" track:false');
    // Full scan — untrack ALL foreign coins at both addresses
    var totalCount = 0;
    function cleanAndShow(addr, callback) {
        if (!addr) { callback(); return; }
        MDS.cmd("coins address:" + addr, function(res) {
            if (!res.status || !res.response) { callback(); return; }
            res.response.forEach(function(c) {
                if (!isMyKey(getState(c, 0))) {
                    MDS.cmd("cointrack enable:false coinid:" + c.coinid);
                    totalCount++;
                }
            });
            callback();
        });
    }
    cleanAndShow(SCRIPT_ADDR_V1, function() {
        cleanAndShow(SCRIPT_ADDR_V2, function() {
            MDS.log("Limit: exit — untracked " + totalCount + " foreign coins, tracking disabled");
            logActivity("Tracking disabled — untracked " + totalCount + " coin" + (totalCount !== 1 ? "s" : ""), "info");
            var msgEl = document.getElementById("exitMsg");
            if (msgEl) msgEl.innerText = totalCount > 0
                ? "Untracked " + totalCount + " order book coin" + (totalCount > 1 ? "s" : "") + " from your node."
                : "Coin tracking disabled. No foreign coins found.";
            document.getElementById("exitModal").style.display = "flex";
        });
    });
}

function getState(coin, port) {
    for (var i = 0; i < coin.state.length; i++) {
        if (coin.state[i].port === port) return coin.state[i].data;
    }
    return "";
}

function parseOrderCoins(coins) {
    ORDERS = [];
    coins.forEach(function(coin) {
        if (!coin.state || coin.state.length < 4) return;
        var ownerkey = getState(coin, 0);
        var wantAddr = getState(coin, 1);
        var wantAmt = getState(coin, 2);
        var wantTok = getState(coin, 3);
        var oid = getState(coin, 4);
        var sideNum = getState(coin, 5);
        var price = getState(coin, 6);
        if (!ownerkey || !wantAddr || !wantAmt) return;

        var side = sideNum === "0" ? "buy" : "sell";
        var displayAmt = (side === "buy" && coin.tokenamount) ? coin.tokenamount : coin.amount;

        ORDERS.push({
            coinid: coin.coinid,
            amount: displayAmt,
            rawAmount: coin.amount,
            tokenamount: coin.tokenamount || coin.amount,
            tokenid: coin.tokenid,
            address: coin.address,
            ownerkey: ownerkey,
            wantAddr: wantAddr,
            wantAmt: parseFloat(wantAmt),
            wantTok: wantTok,
            price: parseFloat(price) || 0,
            orderId: oid,
            side: side,
            sideNum: sideNum,
            isMine: isMyKey(ownerkey),
            created: parseInt(coin.created) || 0
        });
    });
    // Detect maker fills: my orders that disappeared (not cancelled, not collected)
    var currentMine = {};
    ORDERS.forEach(function(o) { if (o.isMine) currentMine[o.coinid] = o; });
    for (var cid in PREV_MY_ORDERS) {
        if (!currentMine[cid] && !CANCEL_STATUS[cid]) {
            var gone = PREV_MY_ORDERS[cid];
            var makerSide = gone.side;
            var amt = gone.side === "buy"
                ? (parseFloat(gone.amount) / gone.price).toFixed(4)
                : parseFloat(gone.amount).toFixed(4);
            recordMyTrade(gone.orderId, "maker", makerSide, gone.price, amt);
            logActivity("Your " + makerSide.toUpperCase() + " order filled — " + amt + " MINIMA @ " + fmtPrice(gone.price), "ok");
        }
    }
    PREV_MY_ORDERS = currentMine;
    renderOrderBook();
    renderMyOrders();
}

function renderOrderBook() {
    var el = document.getElementById("orderList");
    if (ORDERS.length === 0) { el.innerHTML = '<div class="book__empty">No open orders</div>'; return; }
    var sells = ORDERS.filter(function(o) { return o.side === "sell"; }).sort(function(a, b) { return b.price - a.price; });
    var buys = ORDERS.filter(function(o) { return o.side === "buy"; }).sort(function(a, b) { return b.price - a.price; });
    var all = sells.concat(buys);
    var html = "";
    all.forEach(function(o) {
        var isBuy = o.side === "buy";
        var minimaAmt = isBuy ? (parseFloat(o.amount) / o.price).toFixed(2) : parseFloat(o.amount).toFixed(2);
        var usdtTotal = isBuy ? parseFloat(o.amount).toFixed(4) : (parseFloat(o.amount) * o.price).toFixed(4);
        var actionLabel = isBuy ? "SELL" : "BUY";
        var actionClass = isBuy ? "btn--sell" : "btn--buy";
        var safeCoinId = o.coinid.replace(/[^a-fA-F0-9x]/g, '');
        html += '<div class="book__row book__row--' + o.side + '">' +
            '<span class="side-tag side-tag--' + o.side + '">' + o.side.toUpperCase() + '</span>' +
            '<span class="price--' + o.side + '">' + fmtPrice(o.price) + '</span>' +
            '<span>' + minimaAmt + '</span><span>' + usdtTotal + '</span>' +
            '<span><button class="btn ' + actionClass + ' btn--sm" onclick="openFill(\'' + safeCoinId + '\')">' + actionLabel + '</button></span></div>';
    });
    el.innerHTML = html;
}

function renderMyOrders() {
    var mine = ORDERS.filter(function(o) { return o.isMine; });
    var el = document.getElementById("myOrders");
    if (mine.length === 0) { el.innerHTML = '<div class="book__empty">No orders placed</div>'; return; }
    var html = "";
    mine.forEach(function(o) {
        var isBuy = o.side === "buy";
        var minimaAmt = isBuy ? (parseFloat(o.amount) / o.price).toFixed(2) : parseFloat(o.amount).toFixed(2);
        var usdtTotal = isBuy ? parseFloat(o.amount).toFixed(4) : (parseFloat(o.amount) * o.price).toFixed(4);
        var safeCoinId = o.coinid.replace(/[^a-fA-F0-9x]/g, '');
        var cancelState = CANCEL_STATUS[o.coinid];
        // Calculate age for V2 orders
        var age = (o.address === SCRIPT_ADDR_V2 && CURRENT_BLOCK > 0 && o.created > 0) ? CURRENT_BLOCK - o.created : -1;
        var ageHtml = "";
        if (age >= 0) {
            var pct = Math.min(100, Math.round(age / 1500 * 100));
            var ageColor = pct > 90 ? "var(--red)" : pct > 70 ? "var(--accent)" : "var(--dim)";
            var remaining = Math.max(0, 1500 - age);
            var hoursLeft = (remaining * 50 / 3600).toFixed(1);
            var refreshBtn = !cancelState ? '<button class="btn btn--ghost btn--sm" onclick="refreshSingleOrder(\'' + safeCoinId + '\')" title="Reset expiry clock" style="font-size:10px;padding:2px 5px;">↻</button>' : '';
            ageHtml = '<span style="font-size:10px;color:' + ageColor + ';" title="' + age + '/' + '1500 blocks">' + hoursLeft + 'h left</span><br>' + refreshBtn;
        }
        var actionHtml;
        if (cancelState === "pending") {
            actionHtml = '<span class="cancel-status cancel-status--pending">PENDING</span>';
        } else if (cancelState === "confirming") {
            actionHtml = '<span class="cancel-status cancel-status--confirming">CANCELLING...</span>';
        } else if (cancelState === "confirmed") {
            actionHtml = '<span class="cancel-status cancel-status--confirmed">CANCELLED</span>';
        } else {
            actionHtml = '<button class="btn btn--cancel btn--sm" onclick="cancelOrder(\'' + safeCoinId + '\')">X</button>';
        }
        html += '<div class="book__row book__row--' + o.side + '">' +
            '<span class="side-tag side-tag--' + o.side + '">' + o.side.toUpperCase() + '</span>' +
            '<span class="price--' + o.side + '">' + fmtPrice(o.price) + '</span>' +
            '<span>' + minimaAmt + '</span><span>' + usdtTotal + '</span>' +
            '<span>' + ageHtml + '</span>' +
            '<span>' + actionHtml + '</span></div>';
    });
    el.innerHTML = html;
}

// -- Create Order --
// v0.2.0: pre-compute wantAmt so the contract just does VERIFYOUT
function createOrder() {
    var price = document.getElementById("orderPrice").value.trim();
    var amt = document.getElementById("orderAmount").value.trim();
    var statusEl = document.getElementById("createStatus");
    if (!SCRIPTS_REGISTERED) { ensureRegistered(createOrder); return; }

    if (!MY_PUBKEY || !MY_HEX_ADDR) { showErr(statusEl, "Identity not loaded"); return; }
    if (!SCRIPT_ADDR_V2) { showErr(statusEl, "Contract not registered"); return; }
    if (!amt || !price || parseFloat(price) <= 0 || parseFloat(amt) <= 0) { showErr(statusEl, "Valid price and amount required"); return; }

    statusEl.className = "status"; statusEl.innerText = "Creating " + ORDER_SIDE + " order...";
    logActivity("Creating " + ORDER_SIDE.toUpperCase() + " order — " + amt + " MINIMA @ " + price + " USDT...", "info");

    var orderId = "0x" + Date.now().toString(16).toUpperCase();
    var sideNum = ORDER_SIDE === "buy" ? "0" : "1";

    // Pre-compute what the owner wants to receive
    var wantAmt, wantTok, lockAmt, lockTok;
    if (ORDER_SIDE === "sell") {
        // Selling Minima: lock Minima, want USDT
        lockAmt = amt;
        lockTok = "";  // Minima (0x00)
        wantAmt = (parseFloat(amt) * parseFloat(price)).toFixed(8);
        wantTok = USDT_ID;
    } else {
        // Buying Minima: lock USDT, want Minima
        lockAmt = (parseFloat(amt) * parseFloat(price)).toFixed(8);
        lockTok = USDT_ID;
        wantAmt = amt;
        wantTok = "0x00";
    }

    // Check sendable balance before attempting
    logActivity("Checking balance...", "info");
    var unit = lockTok ? "USDT" : "MINIMA";
    MDS.cmd("balance", function(balRes) {
        if (!balRes.status) { showErr(statusEl, "Could not check balance"); logActivity("Balance check failed", "err"); return; }
        var sendable = "0";
        var checkTok = lockTok || "0x00";
        (balRes.response || []).forEach(function(b) {
            if (b.tokenid === checkTok) sendable = b.sendable;
        });
        logActivity("Sendable " + unit + ": " + parseFloat(sendable).toFixed(4) + " — need " + lockAmt, "info");
        if (parseFloat(sendable) < parseFloat(lockAmt)) {
            var errMsg = "Insufficient " + unit + " — need " + lockAmt + ", have " + parseFloat(sendable).toFixed(4);
            showErr(statusEl, errMsg);
            logActivity(errMsg, "err");
            return;
        }

    var stateObj = '{"0":"' + MY_PUBKEY + '","1":"' + MY_HEX_ADDR + '","2":"' + wantAmt + '","3":"' + wantTok + '","4":"' + orderId + '","5":"' + sideNum + '","6":"' + price + '"}';

    var cmd = "send amount:" + lockAmt + " address:" + SCRIPT_ADDR_V2 + " state:" + stateObj;
    if (lockTok) cmd += " tokenid:" + lockTok;

    logActivity("Sending " + lockAmt + " " + unit + " to contract...", "info");
    MDS.log("CREATE: " + cmd);
    MDS.cmd(cmd, function(res) {
        if (isPending(res)) { showPending(statusEl, "Order queued — approve in Pending Actions"); logActivity("Order pending — approve in Pending Actions", "warn"); return; }
        if (res.status) {
            showOk(statusEl, "Order sent to network...");
            logActivity(ORDER_SIDE.toUpperCase() + " order placed — " + amt + " MINIMA @ " + price + " USDT", "ok");
            logActivity("Waiting for on-chain confirmation...", "warn");
            PENDING_CREATE = true;
            document.getElementById("orderAmount").value = "";
            document.getElementById("orderPrice").value = "";
            document.getElementById("totalSummary").innerText = "0.00";
        } else {
            var createErr = res.error || "Failed to create order";
            if (createErr.indexOf("LOCKED") >= 0) {
                showErr(statusEl, "Node keys are LOCKED — unlock your vault to trade");
                logActivity("KEYS LOCKED — unlock your node vault to create orders", "err");
            } else {
                showErr(statusEl, createErr);
                logActivity("Order failed — " + createErr, "err");
            }
        }
    });
    }); // end balance check
}

// -- Cancel Order --
// Sign with owner key explicitly, then txnpost auto:true (runs txnbasics internally)
function cancelOrder(coinid) {
    if (!SCRIPTS_REGISTERED) { ensureRegistered(function() { cancelOrder(coinid); }); return; }
    var order = ORDERS.find(function(o) { return o.coinid === coinid; });
    if (!order) return;
    MDS.notify("Cancelling order...");
    logActivity("Cancelling " + order.side.toUpperCase() + " order — " + parseFloat(order.amount).toFixed(4) + " @ " + fmtPrice(order.price), "info");
    logActivity("Building cancel transaction...", "info");

    var txid = "cancel_" + Date.now();
    var cancelAmt = order.amount;

    MDS.cmd("txncreate id:" + txid, function(r0) {
        if (!r0.status) { MDS.notify("Cancel failed: txncreate"); logActivity("Cancel failed — txncreate error", "err"); return; }

        MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function(r1) {
            if (!r1.status) { showErr(null, "Cancel input failed", txid); return; }

            var outCmd = "txnoutput id:" + txid + " amount:" + cancelAmt + " address:" + order.wantAddr + " storestate:false";
            if (order.side === "buy") outCmd += " tokenid:" + USDT_ID;

            MDS.cmd(outCmd, function(r2) {
                if (!r2.status) { showErr(null, "Cancel output failed", txid); return; }

                // Sign with owner key — triggers pending on restricted MDS
                MDS.cmd("txnsign id:" + txid + " publickey:" + order.ownerkey, function(signRes) {
                    if (isPending(signRes)) {
                        CANCEL_STATUS[coinid] = "pending";
                        renderMyOrders();
                        var csEl = document.getElementById("cancelStatus");
                        csEl.className = "status status--warn";
                        csEl.innerText = "Cancel pending — approve in your node's Pending Actions";
                        logActivity("Cancel pending — approve in Pending Actions", "warn");
                        showPending(null, null, txid, function(ok) {
                            if (ok) {
                                CANCEL_STATUS[coinid] = "confirmed";
                                renderMyOrders();
                                csEl.className = "status status--ok";
                                csEl.innerText = "Order cancelled!";
                                logActivity("Order cancelled", "ok");
                                refreshOrders(); refreshBalances();
                            }
                        });
                        return;
                    }
                    if (signRes && !signRes.status) {
                        var serr = signRes.error || "";
                        if (serr.indexOf("LOCKED") >= 0) {
                            logActivity("KEYS LOCKED — unlock your node vault to cancel orders", "err");
                            var csEl = document.getElementById("cancelStatus");
                            if (csEl) { csEl.className = "status status--err"; csEl.innerText = "Node keys are LOCKED — unlock your vault"; }
                        } else {
                            logActivity("Cancel sign failed — " + serr, "err");
                        }
                        MDS.cmd("txndelete id:" + txid);
                        return;
                    }
                    // Native MDS: sign succeeded, continue
                    logActivity("Signed — posting cancellation...", "info");
                    CANCEL_STATUS[coinid] = "confirming";
                    renderMyOrders();
                    var csEl = document.getElementById("cancelStatus");
                    csEl.className = "status status--warn";
                    csEl.innerText = "Confirming cancellation...";
                    MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function(resArr) {
                        var rp = Array.isArray(resArr) ? resArr[resArr.length - 1] : resArr;
                        if (rp && rp.status) {
                            CANCEL_STATUS[coinid] = "confirmed";
                            renderMyOrders();
                            csEl.className = "status status--ok";
                            csEl.innerText = "Order cancelled!";
                            logActivity("Cancel posted — waiting for confirmation...", "ok");
                            refreshOrders(); refreshBalances();
                        } else {
                            delete CANCEL_STATUS[coinid];
                            renderMyOrders();
                            var cancelErr = "Cancel failed — " + (rp ? rp.error || "unknown" : "no response");
                            csEl.className = "status status--err";
                            csEl.innerText = cancelErr;
                            logActivity(cancelErr, "err");
                        }
                    });
                });
            });
        });
    });
}

// -- Refresh Orders (reset expiry clock) --
function refreshSingleOrder(coinid) {
    var order = ORDERS.find(function(o) { return o.coinid === coinid; });
    if (!order) return;
    if (!SCRIPTS_REGISTERED) { ensureRegistered(function() { refreshSingleOrder(coinid); }); return; }
    refreshNextOrder([order], 0);
}

function refreshMyOrders() {
    if (!SCRIPTS_REGISTERED) { ensureRegistered(refreshMyOrders); return; }
    var mine = ORDERS.filter(function(o) { return o.isMine && o.address === SCRIPT_ADDR_V2; });
    if (mine.length === 0) {
        logActivity("No V2 orders to refresh", "info");
        var rsEl = document.getElementById("refreshStatus");
        if (rsEl) { rsEl.className = "status status--warn"; rsEl.innerText = "No orders to refresh"; setTimeout(function() { rsEl.innerText = ""; rsEl.className = "status"; }, 3000); }
        return;
    }
    logActivity("Refreshing " + mine.length + " order(s)...", "info");
    var rsEl = document.getElementById("refreshStatus");
    if (rsEl) { rsEl.className = "status status--warn"; rsEl.innerText = "Refreshing " + mine.length + " order(s)..."; }
    refreshNextOrder(mine, 0);
}

function refreshNextOrder(orders, idx) {
    if (idx >= orders.length) {
        logActivity("All " + orders.length + " order(s) refreshed — expiry clocks reset", "ok");
        var rsEl = document.getElementById("refreshStatus");
        if (rsEl) { rsEl.className = "status status--ok"; rsEl.innerText = "All orders refreshed!"; setTimeout(function() { rsEl.innerText = ""; rsEl.className = "status"; }, 5000); }
        refreshOrders(); refreshBalances();
        return;
    }
    var o = orders[idx];
    var txid = "refresh_" + Date.now();
    CANCEL_STATUS[o.coinid] = "refreshing";
    logActivity("Refreshing " + o.side.toUpperCase() + " " + parseFloat(o.amount).toFixed(4) + " @ " + fmtPrice(o.price) + "...", "info");

    MDS.cmd("txncreate id:" + txid, function(r0) {
        if (!r0.status) { logActivity("Refresh failed — txncreate", "err"); refreshNextOrder(orders, idx + 1); return; }
        MDS.cmd("txninput id:" + txid + " coinid:" + o.coinid, function(r1) {
            if (!r1.status) { logActivity("Refresh failed — txninput", "err"); MDS.cmd("txndelete id:" + txid); refreshNextOrder(orders, idx + 1); return; }
            // Output back to same script address with same amount
            var outCmd = "txnoutput id:" + txid + " amount:" + o.amount + " address:" + SCRIPT_ADDR_V2 + " storestate:true";
            if (o.tokenid !== "0x00") outCmd += " tokenid:" + o.tokenid;
            MDS.cmd(outCmd, function(r2) {
                if (!r2.status) { logActivity("Refresh failed — txnoutput", "err"); MDS.cmd("txndelete id:" + txid); refreshNextOrder(orders, idx + 1); return; }
                // Set state ports 0-6 via txnstate
                var ports = [
                    { port: 0, value: o.ownerkey },
                    { port: 1, value: o.wantAddr },
                    { port: 2, value: String(o.wantAmt) },
                    { port: 3, value: o.wantTok },
                    { port: 4, value: o.orderId },
                    { port: 5, value: o.sideNum },
                    { port: 6, value: String(o.price) }
                ];
                function setNextState(si) {
                    if (si >= ports.length) {
                        // All state set — sign with owner key and post
                        MDS.cmd("txnsign id:" + txid + " publickey:" + o.ownerkey, function(sr) {
                            if (isPending(sr)) {
                                logActivity("Refresh pending — approve in Pending Actions", "warn");
                                showPending(null, null, txid, function(ok) {
                                    if (ok) {
                                        logActivity("Refreshed " + o.side.toUpperCase() + " @ " + fmtPrice(o.price) + " — clock reset", "ok");
                                    }
                                    refreshNextOrder(orders, idx + 1);
                                });
                                return;
                            }
                            if (sr && !sr.status) {
                                var serr = sr.error || "";
                                if (serr.indexOf("LOCKED") >= 0) {
                                    logActivity("KEYS LOCKED — unlock your vault to refresh orders", "err");
                                } else {
                                    logActivity("Refresh sign failed — " + serr, "err");
                                }
                                MDS.cmd("txndelete id:" + txid);
                                refreshNextOrder(orders, idx + 1);
                                return;
                            }
                            MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function(pr) {
                                var rp = Array.isArray(pr) ? pr[pr.length - 1] : pr;
                                if (rp && rp.status) {
                                    logActivity("Refreshed " + o.side.toUpperCase() + " @ " + fmtPrice(o.price) + " — clock reset", "ok");
                                } else {
                                    logActivity("Refresh post failed — " + (rp ? rp.error || "unknown" : "no response"), "err");
                                    MDS.cmd("txndelete id:" + txid);
                                }
                                refreshNextOrder(orders, idx + 1);
                            });
                        });
                        return;
                    }
                    MDS.cmd("txnstate id:" + txid + " port:" + ports[si].port + " value:" + ports[si].value, function(ss) {
                        if (!ss.status) { logActivity("Refresh failed — txnstate port " + ports[si].port, "err"); MDS.cmd("txndelete id:" + txid); refreshNextOrder(orders, idx + 1); return; }
                        setNextState(si + 1);
                    });
                }
                setNextState(0);
            });
        });
    });
}

// -- Fill Order --
var FILL_ORDER = null;

function openFill(coinid) {
    FILL_ORDER = ORDERS.find(function(o) { return o.coinid === coinid; });
    if (!FILL_ORDER) return;
    var isBuy = FILL_ORDER.side === "buy";

    if (isBuy) {
        var maxMinima = FILL_ORDER.wantAmt;
        document.getElementById("fillTitle").innerText = "Sell into Buy Order (Full Fill)";
        document.getElementById("fillAvail").innerText = maxMinima.toFixed(4) + " MINIMA";
        document.getElementById("fillAmountLabel").innerText = "Minima to sell (full order)";
        document.getElementById("fillAmount").value = maxMinima.toFixed(4);
        document.getElementById("fillCostUnit").innerText = "USDT you receive";
        document.getElementById("fillCost").innerText = parseFloat(FILL_ORDER.amount).toFixed(4);
        document.getElementById("btnFill").className = "btn btn--sell";
        document.getElementById("btnFill").innerText = "Confirm Sell";
    } else {
        document.getElementById("fillTitle").innerText = "Buy from Sell Order (Full Fill)";
        document.getElementById("fillAvail").innerText = parseFloat(FILL_ORDER.amount).toFixed(4) + " MINIMA";
        document.getElementById("fillAmountLabel").innerText = "Minima to buy (full order)";
        document.getElementById("fillAmount").value = parseFloat(FILL_ORDER.amount).toFixed(4);
        document.getElementById("fillCostUnit").innerText = "USDT you pay";
        document.getElementById("fillCost").innerText = FILL_ORDER.wantAmt.toFixed(4);
        document.getElementById("btnFill").className = "btn btn--buy";
        document.getElementById("btnFill").innerText = "Confirm Buy";
    }

    document.getElementById("fillPrice").innerText = fmtPrice(FILL_ORDER.price);
    document.getElementById("fillStatus").innerText = "";
    document.getElementById("fillPanel").style.display = "block";
}

function updateFillCost() {
    if (!FILL_ORDER) return;
    var amt = parseFloat(document.getElementById("fillAmount").value) || 0;
    document.getElementById("fillCost").innerText = (amt * FILL_ORDER.price).toFixed(4);
}

function executeFill() {
    if (!FILL_ORDER || FILL_IN_PROGRESS) return;
    FILL_IN_PROGRESS = true;
    if (FILL_ORDER.side === "sell") fillSellOrder();
    else fillBuyOrder();
}

// Fill SELL order: I pay USDT (wantAmt), I get Minima
// VERIFYOUT checks: output[@INPUT] = (wantAddr, wantAmt, wantTok=USDT)
function fillSellOrder() {
    if (!SCRIPTS_REGISTERED) { ensureRegistered(fillSellOrder); return; }
    var order = FILL_ORDER;
    var statusEl = document.getElementById("fillStatus");
    var orderAmt = parseFloat(order.amount);  // Minima in order
    var usdtCost = order.wantAmt;             // USDT the seller wants
    var txid = "fill_" + Date.now();
    logActivity("Filling SELL — " + orderAmt + " MINIMA @ " + fmtPrice(order.price) + " USDT...", "info");

    statusEl.className = "status"; statusEl.innerText = "Building fill transaction...";
    logActivity("Building transaction...", "info");
    MDS.log("FILL-SELL: minima=" + orderAmt + " usdt=" + usdtCost + " to=" + order.wantAddr);

    MDS.cmd("txncreate id:" + txid, function(r0) {
        if (!r0.status) { showErr(statusEl, "txncreate failed", txid); logActivity("txncreate failed", "err"); return; }

        // Input 0: order coin (Minima at script)
        MDS.cmd("txninput id:" + txid + " coinid:" + order.coinid, function(r1) {
            if (!r1.status) { showErr(statusEl, "Order input failed", txid); logActivity("Order input failed", "err"); return; }

            // Find my USDT to pay
            findCoins(USDT_ID, usdtCost, function(result) {
                if (!result) { showErr(statusEl, "Insufficient USDT (need " + usdtCost + ")", txid); logActivity("Insufficient USDT — need " + usdtCost, "err"); return; }
                logActivity("Found " + result.total.toFixed(4) + " USDT — paying " + usdtCost, "info");

                addMultipleInputs(txid, result.coins, 0, function(ok) {
                    if (!ok) { showErr(statusEl, "USDT input failed", txid); return; }

                    // Output 0: USDT to seller — VERIFYOUT checks this at @INPUT=0
                    var out0 = "txnoutput id:" + txid + " amount:" + usdtCost + " address:" + order.wantAddr + " tokenid:" + USDT_ID + " storestate:false";
                    MDS.cmd(out0, function(r2) {
                        if (!r2.status) { showErr(statusEl, "Payment output failed", txid); return; }

                        // Output 1: Minima to me
                        MDS.cmd("txnoutput id:" + txid + " amount:" + orderAmt + " address:" + MY_HEX_ADDR + " storestate:false", function(r3) {
                            if (!r3.status) { showErr(statusEl, "Minima output failed", txid); return; }

                            // Output 2: USDT change (if any)
                            var usdtChange = (result.total - usdtCost).toFixed(8);
                            var doPost = function() {
                                statusEl.innerText = "Signing...";
                                logActivity("Signing transaction...", "info");
                                var onFillComplete = function(ok) {
                                    if (ok) {
                                        FILL_IN_PROGRESS = false;
                                        showOk(statusEl, "Fill mined!");
                                        logActivity("Fill mined! Bought " + orderAmt + " MINIMA @ " + fmtPrice(order.price), "ok");
                                        PENDING_FILL_COINID = order.coinid;
                                        recordFill(order.orderId, "buy", order.price, orderAmt);
                                        recordMyTrade(order.orderId, "taker", "buy", order.price, orderAmt);
                                        MDS.notify("Bought " + orderAmt + " MINIMA @ " + order.price);
                                        setTimeout(function() { document.getElementById("fillPanel").style.display = "none"; }, 3000);
                                    }
                                };
                                // Step 1: txnsign (triggers pending on restricted MDS)
                                MDS.cmd("txnsign id:" + txid + " publickey:auto", function(signRes) {
                                    MDS.log("FILL-SELL sign: status=" + (signRes ? signRes.status : "null") + " err=" + (signRes ? signRes.error || "none" : "no response"));
                                    if (isPending(signRes)) {
                                        showPending(statusEl, "Approve fill in Pending Actions — will auto-complete", txid, onFillComplete);
                                        logActivity("Fill pending — approve in Pending Actions", "warn");
                                        return;
                                    }
                                    if (signRes && !signRes.status) {
                                        var serr = signRes.error || "";
                                        if (serr.indexOf("LOCKED") >= 0) {
                                            showErr(statusEl, "Node keys are LOCKED — unlock your vault to trade", txid);
                                            logActivity("KEYS LOCKED — unlock your node vault to sign transactions", "err");
                                        } else {
                                            showErr(statusEl, "Sign failed: " + serr, txid);
                                            logActivity("Sign failed — " + serr, "err");
                                        }
                                        return;
                                    }
                                    logActivity("Signed — posting to network...", "info");
                                    statusEl.innerText = "Posting...";
                                    MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function(resArr) {
                                        var rp = Array.isArray(resArr) ? resArr[resArr.length - 1] : resArr;
                                        MDS.log("FILL-SELL post: status=" + (rp ? rp.status : "null") + " err=" + (rp ? rp.error || "none" : "no response"));
                                        if (rp && rp.status) {
                                            FILL_IN_PROGRESS = false;
                                            showOk(statusEl, "Fill submitted! Waiting for mining...");
                                            logActivity("Fill submitted — bought " + orderAmt + " MINIMA @ " + fmtPrice(order.price), "ok");
                                            logActivity("Waiting for on-chain confirmation...", "warn");
                                            PENDING_FILL_COINID = order.coinid;
                                            recordFill(order.orderId, "buy", order.price, orderAmt);
                                            recordMyTrade(order.orderId, "taker", "buy", order.price, orderAmt);
                                            MDS.notify("Bought " + orderAmt + " MINIMA @ " + order.price);
                                            setTimeout(function() {
                                                document.getElementById("fillPanel").style.display = "none";
                                                refreshOrders(); refreshBalances();
                                            }, 3000);
                                        } else {
                                            showErr(statusEl, "Post failed: " + (rp ? rp.error || "unknown" : "no response"), txid);
                                            logActivity("Fill failed — " + (rp ? rp.error || "unknown" : "no response"), "err");
                                        }
                                    });
                                });
                            };

                            if (parseFloat(usdtChange) > 0.000001) {
                                MDS.cmd("txnoutput id:" + txid + " amount:" + usdtChange + " address:" + MY_HEX_ADDR + " tokenid:" + USDT_ID + " storestate:false", function(r4) {
                                    if (!r4.status) { showErr(statusEl, "Change output failed", txid); return; }
                                    doPost();
                                });
                            } else { doPost(); }
                        });
                    });
                });
            });
        });
    });
}

// Fill BUY order: I send Minima (wantAmt), I get USDT
// VERIFYOUT checks: output[@INPUT] = (wantAddr, wantAmt, wantTok=0x00)
function fillBuyOrder() {
    if (!SCRIPTS_REGISTERED) { ensureRegistered(fillBuyOrder); return; }
    var order = FILL_ORDER;
    var statusEl = document.getElementById("fillStatus");
    var usdtAmt = parseFloat(order.amount);   // USDT in order
    var minimaNeeded = order.wantAmt;         // Minima the buyer wants
    var txid = "fill_" + Date.now();

    statusEl.className = "status"; statusEl.innerText = "Building fill transaction...";
    logActivity("Filling BUY — " + minimaNeeded + " MINIMA @ " + fmtPrice(order.price) + " USDT...", "info");
    logActivity("Building transaction...", "info");
    MDS.log("FILL-BUY: minima=" + minimaNeeded + " usdt=" + usdtAmt + " to=" + order.wantAddr);

    MDS.cmd("txncreate id:" + txid, function(r0) {
        if (!r0.status) { showErr(statusEl, "txncreate failed", txid); logActivity("txncreate failed", "err"); return; }

        // Input 0: order coin (USDT at script)
        MDS.cmd("txninput id:" + txid + " coinid:" + order.coinid, function(r1) {
            if (!r1.status) { showErr(statusEl, "Order input failed", txid); logActivity("Order input failed", "err"); return; }

            // Find my Minima to pay
            findCoins("0x00", minimaNeeded, function(result) {
                if (!result) { showErr(statusEl, "Insufficient Minima (need " + minimaNeeded + ")", txid); logActivity("Insufficient MINIMA — need " + minimaNeeded, "err"); return; }
                logActivity("Found " + result.total.toFixed(4) + " MINIMA — paying " + minimaNeeded, "info");

                addMultipleInputs(txid, result.coins, 0, function(ok) {
                    if (!ok) { showErr(statusEl, "Minima input failed", txid); return; }

                    // Output 0: Minima to buyer — VERIFYOUT checks this at @INPUT=0
                    MDS.cmd("txnoutput id:" + txid + " amount:" + minimaNeeded + " address:" + order.wantAddr + " storestate:false", function(r2) {
                        if (!r2.status) { showErr(statusEl, "Minima output failed", txid); return; }

                        // Output 1: USDT to me
                        MDS.cmd("txnoutput id:" + txid + " amount:" + usdtAmt + " address:" + MY_HEX_ADDR + " tokenid:" + USDT_ID + " storestate:false", function(r3) {
                            if (!r3.status) { showErr(statusEl, "USDT output failed", txid); return; }

                            // Output 2: Minima change (if any)
                            var minChange = (result.total - minimaNeeded).toFixed(8);
                            var doPost = function() {
                                statusEl.innerText = "Signing...";
                                logActivity("Signing transaction...", "info");
                                var onFillComplete = function(ok) {
                                    if (ok) {
                                        FILL_IN_PROGRESS = false;
                                        showOk(statusEl, "Fill mined!");
                                        logActivity("Fill mined! Sold " + minimaNeeded + " MINIMA @ " + fmtPrice(order.price), "ok");
                                        PENDING_FILL_COINID = order.coinid;
                                        recordFill(order.orderId, "sell", order.price, minimaNeeded);
                                        recordMyTrade(order.orderId, "taker", "sell", order.price, minimaNeeded);
                                        MDS.notify("Sold " + minimaNeeded + " MINIMA @ " + order.price);
                                        setTimeout(function() { document.getElementById("fillPanel").style.display = "none"; }, 3000);
                                    }
                                };
                                MDS.cmd("txnsign id:" + txid + " publickey:auto", function(signRes) {
                                    MDS.log("FILL-BUY sign: status=" + (signRes ? signRes.status : "null") + " err=" + (signRes ? signRes.error || "none" : "no response"));
                                    if (isPending(signRes)) {
                                        showPending(statusEl, "Approve fill in Pending Actions — will auto-complete", txid, onFillComplete);
                                        logActivity("Fill pending — approve in Pending Actions", "warn");
                                        return;
                                    }
                                    if (signRes && !signRes.status) {
                                        var serr = signRes.error || "";
                                        if (serr.indexOf("LOCKED") >= 0) {
                                            showErr(statusEl, "Node keys are LOCKED — unlock your vault to trade", txid);
                                            logActivity("KEYS LOCKED — unlock your node vault to sign transactions", "err");
                                        } else {
                                            showErr(statusEl, "Sign failed: " + serr, txid);
                                            logActivity("Sign failed — " + serr, "err");
                                        }
                                        return;
                                    }
                                    logActivity("Signed — posting to network...", "info");
                                    statusEl.innerText = "Posting...";
                                    MDS.cmd("txnbasics id:" + txid + ";txnpost id:" + txid, function(resArr) {
                                        var rp = Array.isArray(resArr) ? resArr[resArr.length - 1] : resArr;
                                        MDS.log("FILL-BUY post: status=" + (rp ? rp.status : "null") + " err=" + (rp ? rp.error || "none" : "no response"));
                                        if (rp && rp.status) {
                                            FILL_IN_PROGRESS = false;
                                            showOk(statusEl, "Fill submitted! Waiting for mining...");
                                            logActivity("Fill submitted — sold " + minimaNeeded + " MINIMA @ " + fmtPrice(order.price), "ok");
                                            logActivity("Waiting for on-chain confirmation...", "warn");
                                            PENDING_FILL_COINID = order.coinid;
                                            recordFill(order.orderId, "sell", order.price, minimaNeeded);
                                            recordMyTrade(order.orderId, "taker", "sell", order.price, minimaNeeded);
                                            MDS.notify("Sold " + minimaNeeded + " MINIMA @ " + order.price);
                                            setTimeout(function() {
                                                document.getElementById("fillPanel").style.display = "none";
                                                refreshOrders(); refreshBalances();
                                            }, 3000);
                                        } else {
                                            showErr(statusEl, "Post failed: " + (rp ? rp.error || "unknown" : "no response"), txid);
                                            logActivity("Fill failed — " + (rp ? rp.error || "unknown" : "no response"), "err");
                                        }
                                    });
                                });
                            };

                            if (parseFloat(minChange) > 0.000001) {
                                MDS.cmd("txnoutput id:" + txid + " amount:" + minChange + " address:" + MY_HEX_ADDR + " storestate:false", function(r4) {
                                    if (!r4.status) { showErr(statusEl, "Change output failed", txid); return; }
                                    doPost();
                                });
                            } else { doPost(); }
                        });
                    });
                });
            });
        });
    });
}

// -- Coin Helpers --
function addMultipleInputs(txid, coins, idx, callback) {
    if (idx >= coins.length) { callback(true); return; }
    MDS.cmd("txninput id:" + txid + " coinid:" + coins[idx].coinid, function(res) {
        if (!res.status) { callback(false); return; }
        addMultipleInputs(txid, coins, idx + 1, callback);
    });
}

function coinAmt(coin) {
    if (coin.tokenid !== "0x00" && coin.tokenamount) return parseFloat(coin.tokenamount);
    return parseFloat(coin.amount);
}

function findCoins(tokenid, minAmount, callback) {
    MDS.cmd("coins relevant:true sendable:true tokenid:" + tokenid, function(res) {
        if (!res.status || !res.response || res.response.length === 0) { callback(null); return; }
        var needed = parseFloat(minAmount);
        var sorted = res.response.slice().sort(function(a, b) { return coinAmt(b) - coinAmt(a); });
        if (coinAmt(sorted[0]) >= needed) { callback({ coins: [sorted[0]], total: coinAmt(sorted[0]) }); return; }
        var selected = [], sum = 0;
        for (var i = 0; i < sorted.length; i++) {
            selected.push(sorted[i]); sum += coinAmt(sorted[i]);
            if (sum >= needed) { callback({ coins: selected, total: sum }); return; }
        }
        callback(null);
    });
}

// -- Fill History --
function recordFill(orderId, side, price, amount) {
    var total = (amount * price).toFixed(4);
    var now = Date.now();
    MDS.cmd("block", function(res) {
        var bn = res.status ? parseInt(res.response.block) || 0 : 0;
        MDS.sql(
            "INSERT INTO fills (orderid, side, price, amount, total, block, timestamp) VALUES ('" +
            sqlEsc(orderId) + "', '" + sqlEsc(side) + "', '" + sqlEsc(price) + "', '" + sqlEsc(amount) + "', '" + sqlEsc(total) + "', " + bn + ", " + now + ")",
            function() { loadFills(); }
        );
    });
}

function loadFills(callback) {
    MDS.sql("SELECT * FROM fills ORDER BY timestamp DESC LIMIT 200", function(res) {
        if (!res.status) return;
        FILLS = res.rows || [];
        renderFillHistory();
        if (callback) callback();
    });
}

function renderFillHistory() {
    var el = document.getElementById("historyList");
    if (FILLS.length === 0) { el.innerHTML = '<div class="book__empty">No fills yet</div>'; return; }
    var html = "";
    FILLS.forEach(function(f) {
        var time = new Date(parseInt(f.TIMESTAMP)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        var sideClass = f.SIDE === "buy" ? "side-tag--buy" : "side-tag--sell";
        html += '<div class="history__row">' +
            '<span>' + time + '</span>' +
            '<span class="side-tag ' + sideClass + '">' + f.SIDE.toUpperCase() + '</span>' +
            '<span>' + fmtPrice(parseFloat(f.PRICE)) + '</span>' +
            '<span>' + parseFloat(f.AMOUNT).toFixed(4) + '</span>' +
            '<span>' + parseFloat(f.TOTAL).toFixed(4) + '</span></div>';
    });
    el.innerHTML = html;
}

// -- Charts --
var priceChartObj = null;
var volumeChartObj = null;
var geckoChartObj = null;

function renderCharts() {
    loadFills(buildCharts);
    buildGeckoChart();
}

function buildCharts() {
    if (FILLS.length === 0) return;
    var reversed = FILLS.slice().reverse();
    var labels = reversed.map(function(f) { return new Date(parseInt(f.TIMESTAMP)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); });
    var prices = reversed.map(function(f) { return parseFloat(f.PRICE); });
    var volumes = reversed.map(function(f) { return parseFloat(f.AMOUNT); });
    var pointBorderColors = reversed.map(function(f) { return f.SIDE === "buy" ? "#00e676" : "#ff3b5c"; });
    var C = { accent: "#b45309", accentFill: "rgba(180,83,9,0.08)", grid: "rgba(216,212,204,0.6)", text: "#7a7568", greenBar: "rgba(22,163,74,0.35)", redBar: "rgba(220,38,38,0.3)" };
    var barColors = reversed.map(function(f) { return f.SIDE === "buy" ? C.greenBar : C.redBar; });

    if (priceChartObj) priceChartObj.destroy();
    priceChartObj = new Chart(document.getElementById("priceChart").getContext("2d"), {
        type: "line", data: { labels: labels, datasets: [{ label: "Fill Price (USDT)", data: prices,
            borderColor: C.accent, backgroundColor: C.accentFill, borderWidth: 2,
            pointRadius: 6, pointHoverRadius: 8, pointBackgroundColor: C.accent,
            pointBorderColor: pointBorderColors, pointBorderWidth: 2, fill: true, tension: 0.1 }] },
        options: { responsive: true, plugins: { legend: { display: false },
            title: { display: true, text: "LIMIT FILLS — MINIMA/USDT", color: C.text, font: { family: "Courier New", size: 11 } } },
            scales: { x: { grid: { color: C.grid }, ticks: { color: C.text, font: { size: 9 }, maxRotation: 45 } },
                y: { grid: { color: C.grid }, ticks: { color: C.text, font: { size: 9 } } } } }
    });

    if (volumeChartObj) volumeChartObj.destroy();
    volumeChartObj = new Chart(document.getElementById("volumeChart").getContext("2d"), {
        type: "bar", data: { labels: labels, datasets: [{ label: "Volume (MINIMA)", data: volumes,
            backgroundColor: barColors, borderColor: barColors, borderWidth: 1 }] },
        options: { responsive: true, plugins: { legend: { display: false },
            title: { display: true, text: "FILL VOLUME", color: C.text, font: { family: "Courier New", size: 11 } } },
            scales: { x: { grid: { color: C.grid }, ticks: { color: C.text, font: { size: 9 }, maxRotation: 45 } },
                y: { grid: { color: C.grid }, ticks: { color: C.text, font: { size: 9 } } } } }
    });
}

function buildGeckoChart() {
    fetchGeckoChart(function(data) {
        if (!data || !data.prices) return;
        var prices = data.prices;
        var labels = prices.map(function(p) {
            var d = new Date(p[0]);
            return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit" });
        });
        var vals = prices.map(function(p) { return p[1]; });

        // Sample every Nth point to keep chart clean
        var step = Math.max(1, Math.floor(prices.length / 100));
        var sampledLabels = [], sampledVals = [];
        for (var i = 0; i < labels.length; i += step) {
            sampledLabels.push(labels[i]);
            sampledVals.push(vals[i]);
        }

        var canvas = document.getElementById("geckoChart");
        if (!canvas) return;
        if (geckoChartObj) geckoChartObj.destroy();
        var C = { grid: "rgba(216,212,204,0.6)", text: "#7a7568" };
        geckoChartObj = new Chart(canvas.getContext("2d"), {
            type: "line", data: { labels: sampledLabels, datasets: [{ label: "MINIMA/USD (CoinGecko)", data: sampledVals,
                borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,0.06)", borderWidth: 2,
                pointRadius: 0, fill: true, tension: 0.3 }] },
            options: { responsive: true, plugins: { legend: { display: false },
                title: { display: true, text: "MINIMA/USD — 7 DAY (COINGECKO)", color: C.text, font: { family: "Courier New", size: 11 } } },
                scales: { x: { grid: { color: C.grid }, ticks: { color: C.text, font: { size: 8 }, maxRotation: 45, maxTicksLimit: 12 } },
                    y: { grid: { color: C.grid }, ticks: { color: C.text, font: { size: 9 } } } } }
        });
    });
}
