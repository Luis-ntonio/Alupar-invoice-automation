import { config } from "../config";
import { runCoesAutoSync } from "./coesService";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function executeCoesSync(trigger: "startup" | "daily"): Promise<void> {
  try {
    const result = await runCoesAutoSync(new Date());
    const selected = result.selected
      ? `${result.selected.fileName} (${result.selected.status})`
      : "sin archivo disponible";
    console.log(`[COES] Sync ${trigger}: ${result.status}. Resultado: ${selected}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[COES] Sync ${trigger} fallo: ${msg}`);
  }
}

export function startCoesScheduler(): void {
  if (!config.coesValidationAutoSync) {
    console.log("[COES] Scheduler deshabilitado (COES_VALIDATION_AUTO_SYNC=false).");
    return;
  }

  void executeCoesSync("startup");

  setInterval(() => {
    void executeCoesSync("daily");
  }, ONE_DAY_MS);
}
