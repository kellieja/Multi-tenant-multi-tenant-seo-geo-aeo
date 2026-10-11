// Registers scheduler tick tasks for each module.
import { registerTickTask } from "./scheduler";
import { scheduleDailySyncs } from "@/server/sync";
import { scheduleMaintenance } from "@/server/maintenance";

registerTickTask({ name: "daily-google-syncs", run: scheduleDailySyncs });
registerTickTask({ name: "maintenance", run: scheduleMaintenance });
