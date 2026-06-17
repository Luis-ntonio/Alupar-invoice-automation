"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCoesScheduler = startCoesScheduler;
const config_1 = require("../config");
const coesService_1 = require("./coesService");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
async function executeCoesSync(trigger) {
    try {
        const result = await (0, coesService_1.runCoesAutoSync)(new Date());
        const selected = result.selected
            ? `${result.selected.fileName} (${result.selected.status})`
            : "sin archivo disponible";
        console.log(`[COES] Sync ${trigger}: ${result.status}. Resultado: ${selected}`);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[COES] Sync ${trigger} fallo: ${msg}`);
    }
}
function startCoesScheduler() {
    if (!config_1.config.coesValidationAutoSync) {
        console.log("[COES] Scheduler deshabilitado (COES_VALIDATION_AUTO_SYNC=false).");
        return;
    }
    void executeCoesSync("startup");
    setInterval(() => {
        void executeCoesSync("daily");
    }, ONE_DAY_MS);
}
