import { CronExpressionParser } from "cron-parser";

/** Next run time after `after` for a 5-field cron expression, evaluated in UTC. */
export const nextCronRun = (expr: string, after: Date) => CronExpressionParser.parse(expr, { currentDate: after, tz: "UTC" }).next().toDate();
