/**
 * Limit DEX — Background Service
 * Runs persistently to track order fills and maintain fill history
 */

var SCRIPT = 'IF SIGNEDBY(PREVSTATE(0)) THEN RETURN TRUE ENDIF ASSERT VERIFYOUT(@INPUT PREVSTATE(1) PREVSTATE(2) PREVSTATE(3) FALSE) RETURN TRUE';
var SCRIPT_ADDR = "";

MDS.init(function(msg) {
    if (msg.event === "inited") {
        MDS.cmd('newscript script:"' + SCRIPT + '" trackall:true', function(res) {
            if (res.status) {
                SCRIPT_ADDR = res.response.address;
                MDS.log("Limit service: contract registered at " + SCRIPT_ADDR);
            }
        });
    }

    if (msg.event === "NEWBLOCK") {
        // Ensure contract stays tracked across restarts
        if (!SCRIPT_ADDR) {
            MDS.cmd('newscript script:"' + SCRIPT + '" trackall:true', function(res) {
                if (res.status) SCRIPT_ADDR = res.response.address;
            });
        }
    }
});