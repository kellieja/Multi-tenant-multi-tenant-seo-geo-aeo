import { prisma } from "@/lib/db/client";

export interface NotifyInput {
  organizationId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  severity?: "info" | "warning" | "critical" | "success";
  websiteId?: string | null;
  /** Explicit recipients; defaults to the website's assigned members, else everyone (userId null). */
  userIds?: string[];
}

/**
 * Creates in-app notifications. External delivery (email/Slack) is handled by
 * src/server/delivery.ts when channels are configured.
 */
export async function notify(input: NotifyInput) {
  let recipients = input.userIds;
  if (!recipients && input.websiteId) {
    const assigned = await prisma.websiteAssignment.findMany({ where: { organizationId: input.organizationId, websiteId: input.websiteId }, select: { userId: true } });
    recipients = assigned.map((a) => a.userId);
  }
  const base = {
    organizationId: input.organizationId,
    type: input.type,
    title: input.title.slice(0, 200),
    body: input.body?.slice(0, 2000),
    link: input.link,
    severity: input.severity ?? "info",
  };
  if (recipients && recipients.length) {
    await prisma.notification.createMany({ data: recipients.map((userId) => ({ ...base, userId })) });
  } else {
    await prisma.notification.create({ data: { ...base, userId: null } });
  }
  try {
    const { deliverExternally } = await import("./delivery");
    await deliverExternally(input);
  } catch (err) {
    console.error("[notify] external delivery failed", (err as Error).message);
  }
}
