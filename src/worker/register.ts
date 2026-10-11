// Registers scheduler tick tasks for each module.
import { registerTickTask } from "./scheduler";
import { scheduleDailySyncs } from "@/server/sync";
import { scheduleMaintenance } from "@/server/maintenance";

registerTickTask({ name: "daily-google-syncs", run: scheduleDailySyncs });
registerTickTask({ name: "maintenance", run: scheduleMaintenance });
import { scheduleWorkflows } from "@/server/workflows";
import { expireApprovals } from "@/server/approvals";

registerTickTask({ name: "workflows", run: scheduleWorkflows });
registerTickTask({ name: "expire-approvals", run: expireApprovals });
import { followUpReminders } from "@/server/outreach";

registerTickTask({ name: "outreach-followups", run: followUpReminders });
import { scheduleGeoRuns } from "@/server/geo";

registerTickTask({ name: "geo-runs", run: scheduleGeoRuns });
