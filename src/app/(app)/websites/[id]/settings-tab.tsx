import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { TabProps } from "./tabs";
import { CrawlSettingsForm, AssignmentsForm, DangerZone } from "./settings-forms";

export async function SettingsTab({ ctx, site, settings }: TabProps) {
  const members = await ctx.db.membership.findMany({
    where: { role: { not: "CLIENT" } },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  const canWrite = ctx.can("websites:write");
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Card>
        <CardHeader title="Crawl, schedule & automation settings" description="Applies only to this website. The crawler always respects robots.txt and these rate limits." />
        <CardBody><CrawlSettingsForm id={site.id} settings={settings} disabled={!canWrite} /></CardBody>
      </Card>
      <div className="space-y-5">
        <Card>
          <CardHeader title="Assigned team members" description="Assigned members are notified about this site's alerts and approvals." />
          <CardBody>
            <AssignmentsForm id={site.id} members={members.map((m) => m.user)} assigned={site.assignments.map((a) => a.userId)} disabled={!canWrite} />
          </CardBody>
        </Card>
        {ctx.can("websites:delete") && (
          <Card className="border-bad/30">
            <CardHeader title="Danger zone" />
            <CardBody><DangerZone id={site.id} domain={site.domain} /></CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
