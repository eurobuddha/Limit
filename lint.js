/**
 * Limit v1.0.15 — On-Chain Limit Order DEX for MINIMA/USDT
 * Uses official Minima VERIFYOUT exchange contract pattern
 * FULL FILL ONLY — no partial fills
 *
 * KISS VM Smart Contracts:
 *   V1 (legacy, no expiry, UNSAFE cancel path):
 *     IF SIGNEDBY(PREVSTATE(0)) THEN RETURN TRUE ENDIF
 *     ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE)
 *     RETURN TRUE
 *   V2 (legacy, 1500 block expiry, UNSAFE cancel path):
 *     IF SIGNEDBY(PREVSTATE(0)) THEN RETURN TRUE ENDIF
 *     IF @COINAGE GT 1500 THEN ASSERT VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) RETURN TRUE ENDIF
 *     ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE)
 *     RETURN TRUE
 *   V3 (legacy, 1500 block expiry, ALL paths secured with VERIFYOUT, NO token whitelist):
 *     IF SIGNEDBY(PREVSTATE(0)) THEN ASSERT VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) RETURN TRUE ENDIF
 *     IF @COINAGE GT 1500 THEN ASSERT VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) RETURN TRUE ENDIF
 *     ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE)
 *     RETURN TRUE
 *   V4 (current, hardcoded USDT tokenid — rejects fake tokens at contract level):
 *     LET u=0x7D39... (USDT tokenid)
 *     IF @TOKENID NEQ 0x00 THEN IF @TOKENID NEQ u THEN RETURN FALSE ENDIF ENDIF
 *     IF PREVSTATE(3) NEQ 0x00 THEN IF PREVSTATE(3) NEQ u THEN RETURN FALSE ENDIF ENDIF
 *     [same SIGNEDBY/COINAGE/VERIFYOUT paths as V3]
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
 * EXPIRY: any signer past 1500 blocks → COINAGE branch outputs to PREVSTATE(1). Auto-collected by autoCollectExpired() on NEWBLOCK.
 */

var SCRIPT_V1 = 'IF SIGNEDBY(PREVSTATE(0)) THEN RETURN TRUE ENDIF ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE) RETURN TRUE';
var SCRIPT_V2 = 'IF SIGNEDBY(PREVSTATE(0)) THEN RETURN TRUE ENDIF IF @COINAGE GT 1500 THEN ASSERT VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) RETURN TRUE ENDIF ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE) RETURN TRUE';
var SCRIPT_V3 = 'IF SIGNEDBY(PREVSTATE(0)) THEN ASSERT VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) RETURN TRUE ENDIF IF @COINAGE GT 1500 THEN ASSERT VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) RETURN TRUE ENDIF ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE) RETURN TRUE';
var USDT_ID = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
var SCRIPT_ADDR_V1 = "0x131609A5E510326354647E240F51C53825EFF8CA2B9DE07711EA56055E57672D";
var SCRIPT_ADDR_V2 = "0xE4D3F27BB044500AF56EF775DAFF3A12187EE79A8460FBBBF321F76A660D7797";
var SCRIPT_ADDR_V3 = "0xE0325CC04B1BA1FC630D5E2B157976D01F76507D2049BD9D7D8029A318782BC7";
var SCRIPT_V4 = 'LET u=0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90 IF @TOKENID NEQ 0x00 THEN IF @TOKENID NEQ u THEN RETURN FALSE ENDIF ENDIF IF PREVSTATE(3) NEQ 0x00 THEN IF PREVSTATE(3) NEQ u THEN RETURN FALSE ENDIF ENDIF IF SIGNEDBY(PREVSTATE(0)) THEN ASSERT VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) RETURN TRUE ENDIF IF @COINAGE GT 1500 THEN ASSERT VERIFYOUT(@INPUT PREVSTATE(1) @AMOUNT @TOKENID FALSE) RETURN TRUE ENDIF ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE) RETURN TRUE';
var SCRIPT_ADDR_V4 = "0x94F2CB876903FAED64EA4C9C4B7FD602BAC5CD59F9EBC38AB0C4A0F0B346807F";
var DB_READY = false;
var MY_ADDR = "";
var MY_HEX_ADDR = "";
var MY_PUBKEY = "";
var ORDERS = [];
var FILLS = [];
var MY_KEYS = {};              // all wallet pubkeys {key: true} for isMine check
var ORDER_SIDE = "sell";
var FILL_IN_PROGRESS = false;
var FILL_COINID = null;        // coinid currently being filled — block duplicate fills
var GECKO_PRICE = null;
var PENDING_TXID = null;       // txid awaiting pending approval
var PENDING_CALLBACK = null;   // callback to run after fill completes
var CANCEL_STATUS = {};        // coinid → "pending"|"confirming"|"confirmed"
var PREV_ORDER_COUNT = -1;     // track order book changes
var CURRENT_BLOCK = 0;         // latest block height for age display
var INIT_LOAD_DONE = false;    // suppress auto-collect/refresh until first NEWBLOCK
var PREV_MINIMA_BAL = null;    // track balance changes
var PREV_USDT_BAL = null;
var PENDING_FILL_COINID = null; // coinid of order being filled — watch for removal
var PENDING_CREATE = false;    // true after order send — watch for new mine order to appear
var PENDING_CREATE_GTC = false; // was the just-placed order GTC (drives the confirmation message)
var CREATE_IN_PROGRESS = false; // guard against rapid double-click on Create
var MY_TRADES = [];            // personal trading history from SQL
var PREV_MY_ORDERS = {};       // track mine orders for maker fill detection
var EXPIRED_ORDERS = [];       // V2 orders past 1500 blocks — pending collection
var RENEWING_COINIDS = {};     // oldcoinids mid GTC-renewal/edit (from gtc_renewals SQL) — skip in fill detection
var RENEWING_ORDERIDS = {};    // orderIds mid renewal/edit — drives the "UPDATING…" badge

// -- Init --
MDS.init(function(msg) {
    if (msg.event === "inited") initApp();
    if (msg.event === "NEWBLOCK") {
        updateBlock(msg);
        if (!INIT_LOAD_DONE) INIT_LOAD_DONE = true;
        if (DB_READY) { refreshOrders(); refreshBalances(); }
        if (PENDING_TXID) checkPendingComplete();
        if (PENDING_FILL_COINID) verifyFillLanded();
    }
    if (msg.event === "NEWBALANCE") {
        if (DB_READY) { refreshOrders(); refreshBalances(); clearPendingStatus(); }
    }
});

function initApp() {
    // Register scripts without tracking — coins address: works without trackall
    MDS.cmd('newscript trackall:false script:"' + SCRIPT_V1 + '"', function(r) { MDS.log("newscript V1: status=" + r.status + (r.error ? " err=" + r.error : "")); });
    MDS.cmd('newscript trackall:false script:"' + SCRIPT_V2 + '"', function(r) { MDS.log("newscript V2: status=" + r.status + (r.error ? " err=" + r.error : "")); });
    MDS.cmd('newscript trackall:false script:"' + SCRIPT_V3 + '"', function(r) { MDS.log("newscript V3: status=" + r.status + (r.error ? " err=" + r.error : "")); });
    MDS.cmd('newscript trackall:false script:"' + SCRIPT_V4 + '"', function(r) { MDS.log("newscript V4: status=" + r.status + (r.error ? " err=" + r.error : "")); });
    MDS.log("Limit v1.0.15 contracts: V4=" + SCRIPT_ADDR_V4);
    loadIdentity(function() { finishInit(); });
    MDS.cmd("block", function(res) {
        if (res.status) document.getElementById("blockHeight").innerText = "#" + res.response.block;
    });
    setupUI();
    fetchGeckoPrice();
    setInterval(fetchGeckoPrice, 60000);
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
                ")", function() {
                // In-flight GTC renewal/edit store — shared with service.js (the renewal engine). Both
                // sides CREATE IF NOT EXISTS so whichever context runs first wins; schema must match.
                MDS.sql(
                    "CREATE TABLE IF NOT EXISTS `gtc_renewals` (" +
                    "  `orderid` varchar(160) NOT NULL PRIMARY KEY," +
                    "  `oldcoinid` varchar(160) NOT NULL," +
                    "  `lockamt` varchar(80) NOT NULL," +
                    "  `locktok` varchar(80) NOT NULL," +
                    "  `state` varchar(1024) NOT NULL," +
                    "  `cancelposted` int NOT NULL," +
                    "  `cancelblock` int NOT NULL," +
                    "  `recreatesent` int NOT NULL," +
                    "  `recreateblock` int NOT NULL," +
                    "  `fundsmissing` int NOT NULL," +
                    "  `retries` int NOT NULL," +
                    "  `snapshot` varchar(512) NOT NULL" +
                    ")", function() {
                    MDS.sql(
                        "CREATE TABLE IF NOT EXISTS `gtc_cancelled` (" +
                        "  `orderid` varchar(160) NOT NULL PRIMARY KEY," +
                        "  `block` int NOT NULL" +
                        ")", function() { if (callback) callback(); });
                });
            });
        });
    });
}

function onTablesReady() {
    DB_READY = true;
    MDS.log("Limit v1.0.15 ready. V4=" + SCRIPT_ADDR_V4 + " Keys=" + Object.keys(MY_KEYS).length);
    backfillMyTrades(function() {
        loadActivityLog(function() {
            logActivity("DEX ready — " + Object.keys(MY_KEYS).length + " keys loaded", "info");
            cleanupZombieTxns();
            refreshOrders(); refreshBalances(); loadFills(); loadMyTrades();
        });
    });
}

function cleanupZombieTxns() {
    // Skip if any active operations are in progress — avoid deleting live transactions
    if (FILL_IN_PROGRESS) return;
    var hasActive = false;
    for (var k in CANCEL_STATUS) { hasActive = true; break; }
    if (hasActive) return;
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

// Auto-collect expired orders — returns coins to maker via COINAGE > 1500 branch.
// V4/V3 contract pins the output to PREVSTATE(1) regardless of signer, so the COINAGE
// path works for both own and others' expired orders. Funds always return to maker's wallet.
function autoCollectExpired() {
    if (!EXPIRED_ORDERS || EXPIRED_ORDERS.length === 0) return;
    EXPIRED_ORDERS.forEach(function(c) {
        if (CANCEL_STATUS[c.coinid]) return;
        if (RENEWING_COINIDS[c.coinid]) return;   // mid renewal/edit — the service owns this coin
        var ownerKey = "";
        var ownerAddr = "";
        var orderId = "";
        var sideNum = "";
        var price = "0";
        var isGtcCoin = false;
        var amt = c.tokenamount || c.amount;
        for (var i = 0; i < (c.state || []).length; i++) {
            var s = c.state[i];
            if (s.port === 0) ownerKey = s.data;
            if (s.port === 1) ownerAddr = s.data;
            if (s.port === 4) orderId = s.data;
            if (s.port === 5) sideNum = s.data;
            if (s.port === 6) price = s.data;
            if (s.port === 7 && String(s.data).trim() === "1") isGtcCoin = true;
        }
        if (!ownerAddr) return;
        // Don't self-collect my own GTC order — leave it to the background service to renew (or to another
        // party's collector if the service is down). Collecting it here would race the service's cancel and
        // log a misleading "expired" trade for an order that actually continues.
        if (isGtcCoin && isMyKey(ownerKey)) return;
        var isMine = isMyKey(ownerKey);
        var side = sideNum === "0" ? "buy" : "sell";
        var verb = isMine ? "Auto-collecting your expired " : "Collecting expired ";
        logActivity(verb + side.toUpperCase() + " order — " + fmtAmt(amt) + " @ " + price + " back to maker", "warn");
        CANCEL_STATUS[c.coinid] = "collecting";
        var txid = "collect_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6);
        MDS.cmd("txncreate id:" + txid, function(r0) {
            if (!r0.status) { logActivity("Collect failed — txncreate", "err"); delete CANCEL_STATUS[c.coinid]; return; }
            MDS.cmd("txninput id:" + txid + " coinid:" + c.coinid, function(r1) {
                if (!r1.status) { logActivity("Collect failed — txninput", "err"); MDS.cmd("txndelete id:" + txid); delete CANCEL_STATUS[c.coinid]; return; }
                var outCmd = "txnoutput id:" + txid + " amount:" + fmtAmt(amt) + " address:" + ownerAddr + " storestate:false";
                if (c.tokenid !== "0x00") outCmd += " tokenid:" + c.tokenid;
                MDS.cmd(outCmd, function(r2) {
                    if (!r2.status) { logActivity("Collect failed — txnoutput", "err"); MDS.cmd("txndelete id:" + txid); delete CANCEL_STATUS[c.coinid]; return; }
                    // COINAGE path: sign to populate witness, then post
                    MDS.cmd("txnsign id:" + txid + " publickey:auto", function(sr) {
                    MDS.cmd("txnbasics id:" + txid, function(rbas) {
                        if (!rbas || !rbas.status) { logActivity("Collect failed — txnbasics: " + (rbas ? rbas.error || "unknown" : "no response"), "err"); MDS.cmd("txndelete id:" + txid); delete CANCEL_STATUS[c.coinid]; return; }
                    MDS.cmd("txnpost id:" + txid, function(rp) {
                        if (rp && rp.status) {
                            logActivity("Expired order collected — " + fmtAmt(amt) + " returned to maker", "ok");
                            MDS.cmd("txndelete id:" + txid);
                            // Keep CANCEL_STATUS["collecting"] set until refreshOrders confirms the coin has mined.
                            // Prevents re-firing the collect tx during the mempool→block gap (double-spend reject).
                            if (isMine) {
                                recordMyTrade(orderId, "expired", side, price, amt);
                            }
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
        var isExpired = t.ROLE === "expired";
        var sideClass = isExpired ? "" : (t.SIDE === "buy" ? "side-tag--buy" : "side-tag--sell");
        var sideLabel = isExpired ? "EXPIRED" : t.SIDE.toUpperCase();
        var gp = parseFloat(t.GECKO_PRICE);
        var gpStr = gp > 0 ? fmtPrice(gp) : "—";
        html += '<div class="mytrades__row"' + (isExpired ? ' style="opacity:0.6"' : '') + '>' +
            '<span>' + date + '</span>' +
            '<span class="side-tag ' + sideClass + '" ' + (isExpired ? 'style="color:var(--dim)"' : '') + '>' + sideLabel + '</span>' +
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
        if (t.ROLE === "expired") return; // Expired orders are not trades — exclude from stats
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
            var safeMsg = row.MSG.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            html += '<div class="log-entry"><span class="log-time">'+ts+'</span><span class="log-msg '+cls+'">'+safeMsg+'</span></div>';
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
        MDS.cmd("txnbasics id:" + txid, function(rbas) {
            if (!rbas || !rbas.status) { MDS.log("AUTO-COMPLETE FAILED txnbasics: " + (rbas ? rbas.error || "unknown" : "no response")); if (cb) cb(false); return; }
        MDS.cmd("txnpost id:" + txid, function(rp) {
            MDS.log("AUTO-COMPLETE: status=" + (rp ? rp.status : "null") + " err=" + (rp ? rp.error || "none" : "no response"));
            if (rp && rp.status) {
                MDS.cmd("txndelete id:" + txid);
                MDS.notify("Transaction completed!");
                if (cb) cb(true);
                refreshOrders(); refreshBalances();
            } else {
                MDS.log("AUTO-COMPLETE FAILED: " + (rp ? rp.error || "unknown" : "no response"));
                MDS.cmd("txndelete id:" + txid);
                if (cb) cb(false);
            }
        });
        });
    });
}

function showErr(el, msg, txid) {
    if (el) { el.className = "status status--err"; el.innerText = msg; }
    if (txid) MDS.cmd("txndelete id:" + txid);
    FILL_IN_PROGRESS = false;
    FILL_COINID = null;
    MDS.log("ERROR: " + msg);
}

function showOk(el, msg) {
    if (el) { el.className = "status status--ok"; el.innerText = msg; }
}

// Verify a fill actually mined — if the order coin is gone, the fill landed (ours or someone else's).
// If still present after 3 blocks, our fill was miner-rejected (stale order race).
var FILL_VERIFY_BLOCK = 0;
function verifyFillLanded() {
    if (!PENDING_FILL_COINID) return;
    if (!FILL_VERIFY_BLOCK) FILL_VERIFY_BLOCK = CURRENT_BLOCK;
    if (CURRENT_BLOCK - FILL_VERIFY_BLOCK < 2) return; // wait 2 blocks
    var checkCoinid = PENDING_FILL_COINID;
    MDS.cmd("coins coinid:" + checkCoinid, function(res) {
        if (!res.status) return;
        var found = (res.response && res.response.length > 0);
        if (!found) {
            // Coin spent — fill landed (or someone else filled it)
            MDS.log("FILL VERIFIED: order " + checkCoinid + " spent on-chain");
            PENDING_FILL_COINID = null;
            FILL_COINID = null;
            FILL_VERIFY_BLOCK = 0;
        } else if (CURRENT_BLOCK - FILL_VERIFY_BLOCK >= 5) {
            // Still present after 5 blocks — our fill was rejected
            MDS.log("FILL REJECTED: order " + checkCoinid + " still on-chain after 5 blocks");
            logActivity("Fill failed — order was already taken or expired", "err");
            PENDING_FILL_COINID = null;
            FILL_COINID = null;
            FILL_VERIFY_BLOCK = 0;
        }
    });
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
    CURRENT_BLOCK = parseInt(msg.data.txpow.header.block);
    document.getElementById("blockHeight").innerText = "#" + CURRENT_BLOCK;
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
        FILL_IN_PROGRESS = false;
        FILL_COINID = null;
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
    if (!SCRIPT_ADDR_V1 && !SCRIPT_ADDR_V2 && !SCRIPT_ADDR_V3 && !SCRIPT_ADDR_V4) return;
    var allCoins = [];
    var done = 0, total = (SCRIPT_ADDR_V1 ? 1 : 0) + (SCRIPT_ADDR_V2 ? 1 : 0) + (SCRIPT_ADDR_V3 ? 1 : 0) + (SCRIPT_ADDR_V4 ? 1 : 0);
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
                if ((c.address === SCRIPT_ADDR_V2 || c.address === SCRIPT_ADDR_V3 || c.address === SCRIPT_ADDR_V4) && curBlock > 0) {
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
                var gtcMsg = PENDING_CREATE_GTC ? "GTC order — auto-renews, never expires" : "Order expires in ~1500 blocks (~23h) — funds auto-return on expiry";
                logActivity(gtcMsg, PENDING_CREATE_GTC ? "ok" : "warn");
                logActivity("Waiting for balance update...", "info");
                var csEl = document.getElementById("createStatus");
                if (csEl) { csEl.className = "status status--ok"; csEl.innerText = PENDING_CREATE_GTC ? "Order confirmed — GTC, auto-renews" : "Order confirmed — expires in ~23h, funds auto-return"; setTimeout(function() { csEl.innerText = ""; csEl.className = "status"; }, 8000); }
            }
            // Log order book changes
            if (PREV_ORDER_COUNT >= 0 && liveCoins.length !== PREV_ORDER_COUNT) {
                var diff = liveCoins.length - PREV_ORDER_COUNT;
                logActivity("Order book: " + liveCoins.length + " orders (" + (diff > 0 ? "+" : "") + diff + ")", "info");
            }
            PREV_ORDER_COUNT = liveCoins.length;
            // Clear "collecting" locks for coins that have mined (no longer present on-chain).
            // autoCollectExpired sets CANCEL_STATUS["collecting"] and leaves it until the coin disappears
            // from the V4 query — this prevents the mempool-gap double-fire described in code review.
            var allCoinIds = {};
            allCoins.forEach(function(ac) { allCoinIds[ac.coinid] = true; });
            for (var cid in CANCEL_STATUS) {
                if (CANCEL_STATUS[cid] === "collecting" && !allCoinIds[cid]) {
                    delete CANCEL_STATUS[cid];
                }
            }
            // Load the in-flight GTC renewal/edit set (written by service.js) BEFORE parsing, so the
            // maker-fill detector doesn't record a false "fill" when the service cancels a coin to renew it.
            loadRenewing(function() {
                parseOrderCoins(liveCoins);
                if (INIT_LOAD_DONE) { autoCollectExpired(); }
            });
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
    if (SCRIPT_ADDR_V3) {
        MDS.cmd("coins address:" + SCRIPT_ADDR_V3, function(res) {
            if (res.status && res.response) allCoins = allCoins.concat(res.response);
            onAllCoins();
        });
    }
    if (SCRIPT_ADDR_V4) {
        MDS.cmd("coins address:" + SCRIPT_ADDR_V4, function(res) {
            if (res.status && res.response) allCoins = allCoins.concat(res.response);
            onAllCoins();
        });
    }
}

function exitDex() {
    logActivity("Session closed", "info");
    document.getElementById("exitModal").style.display = "flex";
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
        // Defence in depth: reject orders with unrecognised tokens (V1/V2/V3 have no on-chain token check)
        if (coin.tokenid !== "0x00" && coin.tokenid !== USDT_ID) return;
        if (wantTok !== "0x00" && wantTok !== USDT_ID) return;

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
            price: parseFloat(price) || 0.0001,
            orderId: oid,
            side: side,
            sideNum: sideNum,
            gtc: getState(coin, 7).trim() === "1",
            isMine: isMyKey(ownerkey),
            created: parseInt(coin.created) || 0
        });
    });
    // Detect maker fills: my orders that disappeared (not cancelled, not collected, not mid-renewal/edit)
    var currentMine = {};
    ORDERS.forEach(function(o) { if (o.isMine) currentMine[o.coinid] = o; });
    for (var cid in PREV_MY_ORDERS) {
        if (!currentMine[cid] && !CANCEL_STATUS[cid] && !RENEWING_COINIDS[cid]) {
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
    // Filter out dust orders (tiny amounts that clutter the book)
    var minMinima = 0.01;
    var sells = ORDERS.filter(function(o) {
        if (o.side !== "sell") return false;
        return parseFloat(o.amount) >= minMinima;
    }).sort(function(a, b) { return b.price - a.price; });
    var buys = ORDERS.filter(function(o) {
        if (o.side !== "buy") return false;
        var minimaAmt = parseFloat(o.amount) / o.price;
        return minimaAmt >= minMinima;
    }).sort(function(a, b) { return b.price - a.price; });
    var all = sells.concat(buys);
    var html = "";
    all.forEach(function(o) {
        var isBuy = o.side === "buy";
        var minimaAmt = isBuy ? (parseFloat(o.amount) / o.price).toFixed(2) : parseFloat(o.amount).toFixed(2);
        var usdtTotal = isBuy ? parseFloat(o.amount).toFixed(4) : (parseFloat(o.amount) * o.price).toFixed(4);
        var actionLabel = isBuy ? "SELL" : "BUY";
        var actionClass = isBuy ? "btn--sell" : "btn--buy";
        var safeCoinId = o.coinid.replace(/[^a-fA-F0-9x]/g, '');
        var gtcMark = o.gtc ? ' <span class="side-tag" style="color:var(--green);" title="Good-till-cancelled">∞</span>' : '';
        html += '<div class="book__row book__row--' + o.side + '">' +
            '<span class="side-tag side-tag--' + o.side + '">' + o.side.toUpperCase() + gtcMark + '</span>' +
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
        var age = ((o.address === SCRIPT_ADDR_V2 || o.address === SCRIPT_ADDR_V3 || o.address === SCRIPT_ADDR_V4) && CURRENT_BLOCK > 0 && o.created > 0) ? CURRENT_BLOCK - o.created : -1;
        var ageHtml = "";
        if (o.gtc) {
            ageHtml = '<span style="font-size:10px;color:var(--green);" title="Good-till-cancelled — auto-renews">∞ GTC</span>';
        } else if (age >= 0) {
            var pct = Math.min(100, Math.round(age / 1500 * 100));
            var ageColor = pct > 90 ? "var(--red)" : pct > 70 ? "var(--accent)" : "var(--dim)";
            var remaining = Math.max(0, 1500 - age);
            var hoursLeft = (remaining * 50 / 3600).toFixed(1);
            ageHtml = '<span style="font-size:10px;color:' + ageColor + ';" title="' + age + '/' + '1500 blocks">' + hoursLeft + 'h left</span>';
        }
        var actionHtml;
        if (RENEWING_ORDERIDS[o.orderId]) {
            actionHtml = '<span class="cancel-status cancel-status--confirming">UPDATING…</span>';
        } else if (cancelState === "pending") {
            actionHtml = '<span class="cancel-status cancel-status--pending">PENDING</span>';
        } else if (cancelState === "confirming") {
            actionHtml = '<span class="cancel-status cancel-status--confirming">CANCELLING...</span>';
        } else if (cancelState === "confirmed") {
            actionHtml = '<span class="cancel-status cancel-status--confirmed">CANCELLED</span>';
        } else {
            actionHtml = '<button class="btn btn--edit btn--sm" title="Edit price" onclick="editOrder(\'' + safeCoinId + '\')">✎</button>' +
                         '<button class="btn btn--cancel btn--sm" onclick="cancelOrder(\'' + safeCoinId + '\')">X</button>';
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

// Load the in-flight GTC renewal/edit set from the shared SQL table (written by service.js). Used to
// (a) suppress false maker-fill records while the service cancels a coin to renew it, and (b) show the
// "UPDATING…" badge. Table may not exist yet on very first run — that's fine (SELECT errors → empty).
function loadRenewing(cb) {
    RENEWING_COINIDS = {}; RENEWING_ORDERIDS = {};
    MDS.sql("SELECT oldcoinid, orderid FROM gtc_renewals", function(res) {
        if (res && res.status && res.rows) res.rows.forEach(function(r) {
            RENEWING_COINIDS[r.OLDCOINID] = true;
            RENEWING_ORDERIDS[r.ORDERID] = true;
        });
        if (cb) cb();
    });
}

// -- Edit Order (change price = cancel + re-place, via the service's renewal state machine) --
function editOrder(coinid) {
    var order = ORDERS.find(function(o) { return o.coinid === coinid; });
    if (!order) return;
    if (RENEWING_ORDERIDS[order.orderId]) { logActivity("Order is already updating — try again shortly", "warn"); return; }
    var isBuy = order.side === "buy";
    var lockedLabel = isBuy
        ? "Your locked " + parseFloat(order.amount).toFixed(4) + " USDT stays; the MINIMA you ask for changes."
        : "Your locked " + parseFloat(order.amount).toFixed(4) + " MINIMA stays; the USDT you ask for changes.";
    var wrap = document.createElement("div");
    wrap.className = "modal-overlay";
    wrap.innerHTML =
        '<div class="modal">' +
        '<h3 class="modal__title">Edit ' + order.side.toUpperCase() + ' — new price (USDT per MINIMA)</h3>' +
        '<p class="modal__desc">' + lockedLabel + (order.gtc ? ' GTC stays on.' : '') +
        ' The order is cancelled and re-placed — it leaves the book for a block or two.</p>' +
        '<input type="number" id="editPrice" class="field__input" step="0.0001" min="0.0001">' +
        '<div class="modal__actions">' +
        '<button class="btn btn--sm" id="editBackBtn">Back</button>' +
        '<button class="btn btn--buy btn--sm" id="editSaveBtn">Re-place</button>' +
        '</div></div>';
    document.body.appendChild(wrap);
    var pi = document.getElementById("editPrice");
    pi.value = fmtPrice(order.price);
    document.getElementById("editBackBtn").onclick = function() { document.body.removeChild(wrap); };
    document.getElementById("editSaveBtn").onclick = function() {
        var np = pi.value.trim();
        document.body.removeChild(wrap);
        doEdit(coinid, np);
    };
    pi.focus(); try { pi.select(); } catch(e) {}
}

function doEdit(coinid, priceStr) {
    var order = ORDERS.find(function(o) { return o.coinid === coinid; });
    if (!order) return;
    var price = parseFloat(priceStr);
    if (!(price > 0)) { logActivity("Enter a valid price", "err"); return; }
    var isBuy = order.side === "buy";
    var lockedAmt = parseFloat(order.amount);   // SELL: locked MINIMA; BUY: locked USDT
    var newWantAmt, newMinima;
    if (!isBuy) {                                // SELL: locked MINIMA fixed → wanted USDT = MINIMA × price
        newWantAmt = (lockedAmt * price).toFixed(8);
        newMinima = lockedAmt;
    } else {                                     // BUY: locked USDT fixed → wanted MINIMA = USDT ÷ price
        newMinima = lockedAmt / price;
        if (newMinima < 0.01) { logActivity("Result is below the 0.01 MINIMA minimum", "err"); return; }
        newWantAmt = newMinima.toFixed(8);
    }
    // editedState: preserve owner(0)/wantAddr(1)/wantTok(3)/orderId(4)/side(5) + port 7 EXACTLY (edit never
    // grants/removes GTC); update port 2 (want amount) + port 6 (price).
    // Port 6 is display-only; store the normalized numeric string (not the raw field text) so a value like
    // "0.5x" can't corrupt the state JSON. The contract enforces port 2 (want amount) which we computed above.
    var priceState = String(price);
    var st = '{"0":"' + order.ownerkey + '","1":"' + order.wantAddr + '","2":"' + newWantAmt +
             '","3":"' + order.wantTok + '","4":"' + order.orderId + '","5":"' + order.sideNum +
             '","6":"' + priceState + '"' + (order.gtc ? ',"7":"1"' : '') + '}';
    var lockAmt = order.amount;                  // locked token amount (tokenamount for buy, amount for sell)
    var lockTok = order.tokenid;
    var snap = JSON.stringify({ side: order.side, price: price, minima: newMinima });
    // Write the intent row; service.js posts the cancel + recreate. Optimistic UI badge now.
    RENEWING_ORDERIDS[order.orderId] = true; RENEWING_COINIDS[order.coinid] = true; renderMyOrders();
    // DELETE any pending renewal row FIRST so the edit SUPERSEDES a concurrent auto-renewal (the PRIMARY
    // KEY on orderid means a stray renewal INSERT can't create a second row that re-places at the old price).
    MDS.sql("DELETE FROM gtc_renewals WHERE orderid='" + sqlEsc(order.orderId) + "'", function() {
    MDS.sql("INSERT INTO gtc_renewals (orderid, oldcoinid, lockamt, locktok, state, cancelposted, cancelblock, recreatesent, recreateblock, fundsmissing, retries, snapshot) VALUES ('" +
        sqlEsc(order.orderId) + "','" + sqlEsc(order.coinid) + "','" + sqlEsc(lockAmt) + "','" + sqlEsc(lockTok) + "','" +
        sqlEsc(st) + "',0,0,0,0,0,0,'" + sqlEsc(snap) + "')", function(res) {
        if (res && res.status) {
            logActivity("Editing " + order.side.toUpperCase() + " → " + fmtPrice(price) + " — cancel + re-place in progress", "info");
            MDS.notify("Order edit queued — re-placing at " + fmtPrice(price));
        } else {
            delete RENEWING_ORDERIDS[order.orderId]; delete RENEWING_COINIDS[order.coinid]; renderMyOrders();
            logActivity("Edit failed — could not queue (order unchanged)", "err");
        }
    });
    });
}

// -- Create Order --
// v0.2.0: pre-compute wantAmt so the contract just does VERIFYOUT
function createOrder() {
    var price = document.getElementById("orderPrice").value.trim();
    var amt = document.getElementById("orderAmount").value.trim();
    var statusEl = document.getElementById("createStatus");

    if (CREATE_IN_PROGRESS) { logActivity("Order already submitting — wait for confirmation", "warn"); return; }
    if (!MY_PUBKEY || !MY_HEX_ADDR) { showErr(statusEl, "Identity not loaded"); return; }
    if (!SCRIPT_ADDR_V4) { showErr(statusEl, "V4 contract not registered"); return; }
    if (!amt || !price || parseFloat(price) <= 0 || parseFloat(amt) <= 0) { showErr(statusEl, "Valid price and amount required"); return; }
    if (parseFloat(amt) < 0.01) { showErr(statusEl, "Amount too low — minimum 0.01 MINIMA"); logActivity("Order rejected — amount too low", "err"); return; }

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

    // GTC (good-till-cancelled): mark the order with state port 7 = "1". The V4 script ignores ports >3
    // so this is invisible/harmless to the contract; service.js auto-renews it before the 1500 expiry.
    var gtcEl = document.getElementById("gtcToggle");
    var isGtc = gtcEl ? gtcEl.checked : false;
    var stateObj = '{"0":"' + MY_PUBKEY + '","1":"' + MY_HEX_ADDR + '","2":"' + wantAmt + '","3":"' + wantTok + '","4":"' + orderId + '","5":"' + sideNum + '","6":"' + price + '"' + (isGtc ? ',"7":"1"' : '') + '}';

    var cmd = "send amount:" + lockAmt + " address:" + SCRIPT_ADDR_V4 + " state:" + stateObj;
    if (lockTok) cmd += " tokenid:" + lockTok;

    logActivity("Sending " + lockAmt + " " + unit + " to contract...", "info");
    MDS.log("CREATE: " + cmd);
    CREATE_IN_PROGRESS = true;
    MDS.cmd(cmd, function(res) {
        CREATE_IN_PROGRESS = false;
        if (isPending(res)) { showPending(statusEl, "Order queued — approve in Pending Actions"); logActivity("Order pending — approve in Pending Actions", "warn"); return; }
        if (res.status) {
            showOk(statusEl, "Order sent to network...");
            logActivity(ORDER_SIDE.toUpperCase() + " order placed — " + amt + " MINIMA @ " + price + (isGtc ? " USDT (GTC)" : " USDT"), "ok");
            logActivity("Waiting for on-chain confirmation...", "warn");
            PENDING_CREATE = true;
            PENDING_CREATE_GTC = isGtc;
            document.getElementById("orderAmount").value = "";
            document.getElementById("orderPrice").value = "";
            document.getElementById("totalSummary").innerText = "0.00";
        } else {
            var createErr = res.error || "Failed to create order";
            if (createErr.indexOf("LOCKED") >= 0) {
                showErr(statusEl, "Node keys are LOCKED — unlock your vault to trade");
                logActivity("KEYS LOCKED — unlock your node vault to create orders", "err");
            } else if (createErr.indexOf("nsufficient") >= 0) {
                showErr(statusEl, "Insufficient funds — wait for previous transaction to confirm");
                logActivity("Order failed — coins locked in pending transaction, try again after next block", "err");
            } else {
                showErr(statusEl, createErr);
                logActivity("Order failed — " + createErr, "err");
            }
        }
    });
    }); // end balance check
}

// -- Cancel Order --
// Sign with owner key, then txnbasics + txnpost sequentially
function cancelOrder(coinid) {
    var order = ORDERS.find(function(o) { return o.coinid === coinid; });
    if (!order) return;
    if (CANCEL_STATUS[coinid]) { logActivity("Cancel already in progress for this order", "warn"); return; }
    // A manual cancel is a WITHDRAW intent — suppress any GTC auto-renewal/edit for this order so the
    // background service can't re-lock the funds. (Marker pruned by the service after ~2000 blocks.)
    if (order.gtc || RENEWING_ORDERIDS[order.orderId]) {
        MDS.sql("INSERT INTO gtc_cancelled (orderid, block) VALUES ('" + sqlEsc(order.orderId) + "'," + (CURRENT_BLOCK || 0) + ")");
        MDS.sql("DELETE FROM gtc_renewals WHERE orderid='" + sqlEsc(order.orderId) + "'");
        delete RENEWING_ORDERIDS[order.orderId]; delete RENEWING_COINIDS[order.coinid];
    }
    CANCEL_STATUS[coinid] = "building";
    MDS.notify("Cancelling order...");
    logActivity("Cancelling " + order.side.toUpperCase() + " order — " + parseFloat(order.amount).toFixed(4) + " @ " + fmtPrice(order.price), "info");
    logActivity("Building cancel transaction...", "info");

    var txid = "cancel_" + Date.now();
    var cancelAmt = order.amount;

    MDS.cmd("txncreate id:" + txid, function(r0) {
        if (!r0.status) { delete CANCEL_STATUS[coinid]; MDS.notify("Cancel failed: txncreate"); logActivity("Cancel failed — txncreate error", "err"); return; }

        MDS.cmd("txninput id:" + txid + " coinid:" + coinid, function(r1) {
            if (!r1.status) {
                delete CANCEL_STATUS[coinid];
                var inputErr = r1.error || "unknown";
                if (inputErr.indexOf("not found") >= 0 || inputErr.indexOf("Not found") >= 0) {
                    logActivity("Order already filled or cancelled — coin no longer exists", "warn");
                    MDS.notify("Order already gone"); MDS.cmd("txndelete id:" + txid);
                } else {
                    showErr(null, "Cancel input failed: " + inputErr, txid);
                }
                return;
            }

            var outCmd = "txnoutput id:" + txid + " amount:" + fmtAmt(cancelAmt) + " address:" + order.wantAddr + " storestate:false";
            if (order.side === "buy") outCmd += " tokenid:" + USDT_ID;

            MDS.cmd(outCmd, function(r2) {
                if (!r2.status) { delete CANCEL_STATUS[coinid]; showErr(null, "Cancel output failed", txid); return; }

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
                    // Native MDS: sign succeeded, add proofs and post
                    logActivity("Signed — posting cancellation...", "info");
                    CANCEL_STATUS[coinid] = "confirming";
                    renderMyOrders();
                    var csEl = document.getElementById("cancelStatus");
                    csEl.className = "status status--warn";
                    csEl.innerText = "Confirming cancellation...";
                    MDS.cmd("txnbasics id:" + txid, function(rbas) {
                        if (!rbas || !rbas.status) { delete CANCEL_STATUS[coinid]; renderMyOrders(); logActivity("Cancel failed — txnbasics: " + (rbas ? rbas.error || "unknown" : "no response"), "err"); MDS.cmd("txndelete id:" + txid); return; }
                    MDS.cmd("txnpost id:" + txid, function(rp) {
                        if (rp && rp.status) {
                            MDS.cmd("txndelete id:" + txid);
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
                            MDS.cmd("txndelete id:" + txid);
                        }
                    });
                    });
                });
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
    if (FILL_COINID === FILL_ORDER.coinid) {
        logActivity("Already filling this order — wait for confirmation", "warn");
        return;
    }
    FILL_IN_PROGRESS = true;
    FILL_COINID = FILL_ORDER.coinid;
    // Verify order coin still exists before building tx
    var checkId = FILL_ORDER.coinid;
    MDS.cmd("coins coinid:" + checkId, function(res) {
        if (!res.status || !res.response || res.response.length === 0) {
            showErr(document.getElementById("fillStatus"), "Order already taken or cancelled");
            logActivity("Fill aborted — order coin no longer exists", "err");
            return;
        }
        if (FILL_ORDER.side === "sell") fillSellOrder();
        else fillBuyOrder();
    });
}

// Fill SELL order: I pay USDT (wantAmt), I get Minima
// VERIFYOUT checks: output[@INPUT] = (wantAddr, wantAmt, wantTok=USDT)
function fillSellOrder() {
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
                    var out0 = "txnoutput id:" + txid + " amount:" + fmtAmt(usdtCost) + " address:" + order.wantAddr + " tokenid:" + USDT_ID + " storestate:false";
                    MDS.cmd(out0, function(r2) {
                        if (!r2.status) { showErr(statusEl, "Payment output failed", txid); return; }

                        // Output 1: Minima to me
                        MDS.cmd("txnoutput id:" + txid + " amount:" + fmtAmt(orderAmt) + " address:" + MY_HEX_ADDR + " storestate:false", function(r3) {
                            if (!r3.status) { showErr(statusEl, "Minima output failed", txid); return; }

                            // Output 2: USDT change (if any)
                            var usdtChange = (result.total - usdtCost).toFixed(8);
                            var doPost = function() {
                                statusEl.innerText = "Signing...";
                                logActivity("Signing transaction...", "info");
                                var onFillComplete = function(ok) {
                                    if (ok) {
                                        MDS.cmd("txndelete id:" + txid);
                                        FILL_IN_PROGRESS = false;
                                        showOk(statusEl, "Fill mined!");
                                        logActivity("Fill mined! Bought " + orderAmt + " MINIMA @ " + fmtPrice(order.price), "ok");
                                        PENDING_FILL_COINID = order.coinid;
                                        recordFill(order.orderId, "buy", order.price, orderAmt);
                                        recordMyTrade(order.orderId, "taker", "buy", order.price, orderAmt);
                                        MDS.notify("Bought " + orderAmt + " MINIMA @ " + order.price);
                                        setTimeout(function() { document.getElementById("fillPanel").style.display = "none"; refreshOrders(); refreshBalances(); }, 3000);
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
                                    MDS.cmd("txnbasics id:" + txid, function(rbas) {
                                        if (!rbas || !rbas.status) { showErr(statusEl, "txnbasics failed: " + (rbas ? rbas.error || "unknown" : "no response"), txid); logActivity("Fill failed — txnbasics", "err"); return; }
                                    MDS.cmd("txnpost id:" + txid, function(rp) {
                                        MDS.log("FILL-SELL post: status=" + (rp ? rp.status : "null") + " err=" + (rp ? rp.error || "none" : "no response"));
                                        if (rp && rp.status) {
                                            MDS.cmd("txndelete id:" + txid);
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
                    MDS.cmd("txnoutput id:" + txid + " amount:" + fmtAmt(minimaNeeded) + " address:" + order.wantAddr + " storestate:false", function(r2) {
                        if (!r2.status) { showErr(statusEl, "Minima output failed", txid); return; }

                        // Output 1: USDT to me
                        MDS.cmd("txnoutput id:" + txid + " amount:" + fmtAmt(usdtAmt) + " address:" + MY_HEX_ADDR + " tokenid:" + USDT_ID + " storestate:false", function(r3) {
                            if (!r3.status) { showErr(statusEl, "USDT output failed", txid); return; }

                            // Output 2: Minima change (if any)
                            var minChange = (result.total - minimaNeeded).toFixed(8);
                            var doPost = function() {
                                statusEl.innerText = "Signing...";
                                logActivity("Signing transaction...", "info");
                                var onFillComplete = function(ok) {
                                    if (ok) {
                                        MDS.cmd("txndelete id:" + txid);
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
                                    MDS.cmd("txnbasics id:" + txid, function(rbas) {
                                        if (!rbas || !rbas.status) { showErr(statusEl, "txnbasics failed: " + (rbas ? rbas.error || "unknown" : "no response"), txid); logActivity("Fill failed — txnbasics", "err"); return; }
                                    MDS.cmd("txnpost id:" + txid, function(rp) {
                                        MDS.log("FILL-BUY post: status=" + (rp ? rp.status : "null") + " err=" + (rp ? rp.error || "none" : "no response"));
                                        if (rp && rp.status) {
                                            MDS.cmd("txndelete id:" + txid);
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

// Format amount to avoid scientific notation (e.g. 1e-7) in Minima RPC commands
function fmtAmt(n) { return parseFloat(n).toFixed(8); }

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
        var maxInputs = 10; // cap inputs to stay under 65536 byte TxPoW limit
        for (var i = 0; i < sorted.length && selected.length < maxInputs; i++) {
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
