import { safeSmtpOptions } from "@/lib/net/smtp";
import { prisma } from "@/lib/db/client";
import { findConnection, readSecret } from "@/integrations/connections";
import type { NotifyInput } from "./notifications";

/** Sends an email through the org's SMTP integration, or the server SMTP_URL fallback. */
export async function sendEmail(organizationId: string, msg: { to: string | string[]; subject: string; text: string; html?: string; replyTo?: string; attachments?: { filename: string; content: Buffer; contentType?: string }[] }) {
  const conn = await findConnection(organizationId, "SMTP", null);
  const cfg = conn?.encryptedSecret ? readSecret<{ url: string; from: string }>(conn) : process.env.SMTP_URL ? { url: process.env.SMTP_URL, from: process.env.EMAIL_FROM ?? "" } : null;
  if (!cfg?.url) throw new Error("Email isn't configured. Connect SMTP in Integrations or set SMTP_URL.");
  const nodemailer = await import("nodemailer");
  // Org-supplied SMTP URLs are pinned to a checked public address; the operator's SMTP_URL is trusted as-is.
  const transport = nodemailer.createTransport(conn?.encryptedSecret ? await safeSmtpOptions(cfg.url) : cfg.url);
  const info = await transport.sendMail({ from: cfg.from || process.env.EMAIL_FROM, ...msg });
  return info.messageId as string;
}

export async function postSlack(organizationId: string, text: string) {
  const conn = await findConnection(organizationId, "SLACK_WEBHOOK", null);
  if (!conn?.encryptedSecret) return false;
  const { webhookUrl } = readSecret<{ webhookUrl: string }>(conn);
  const u = new URL(webhookUrl);
  if (u.hostname !== "hooks.slack.com") throw new Error("Invalid Slack webhook host");
  const res = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
  return true;
}

/** Warning/critical notifications are mirrored to Slack and the org alert email when configured. */
export async function deliverExternally(n: NotifyInput) {
  if (n.severity !== "warning" && n.severity !== "critical" && n.type !== "approval_requested") return;
  const link = n.link ? `${process.env.APP_URL ?? ""}${n.link}` : "";
  const text = `*${n.title}*${n.body ? `\n${n.body}` : ""}${link ? `\n${link}` : ""}`;
  await postSlack(n.organizationId, text).catch((e) => console.error("[slack]", e.message));
  const org = await prisma.organization.findUnique({ where: { id: n.organizationId }, select: { settings: true } });
  const to = (org?.settings as { notifyEmail?: string } | null)?.notifyEmail;
  if (to) await sendEmail(n.organizationId, { to, subject: n.title, text: text.replace(/\*/g, "") }).catch((e) => console.error("[email]", e.message));
}
