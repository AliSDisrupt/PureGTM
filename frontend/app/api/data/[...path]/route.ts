import { NextRequest, NextResponse } from "next/server";
import { safeQuery } from "../../../../lib/serverDb";

export const runtime = "nodejs";

type QueryLike = { startDate?: string; endDate?: string };
type KPI = { spend: string; impressions: string; clicks: string; leads: string; conversions: string; ctr: string };
type LemlistActivity = { campaignId?: string; createdAt?: string; type?: string; metaData?: { campaignId?: string; type?: string } };
type LemlistCampaignListItem = { _id?: string; name?: string; archived?: boolean; status?: string };
type FluentLead = { date: string; name: string; email: string; company: string; priority: string; lead_type: string; source_tab: string };

const ZERO_KPI: KPI = { spend: "0", impressions: "0", clicks: "0", leads: "0", conversions: "0", ctr: "0" };
const FLUENT_FORM_SHEET_ID = "1T1P5o6vSdgLjsMxzsxJx4hPNtfz-homeji2__ZlVH30";
const FLUENT_FORM_TABS = ["White-label", "Vpn Reseller-Paid", "Vpn Reseller - Organic", "PurewL", "PureWL - Contact US"];

function getDateRange(query: QueryLike): { startDate: string; endDate: string } {
  return {
    startDate: query.startDate ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    endDate: query.endDate ?? new Date().toISOString().slice(0, 10)
  };
}

function parseDdMmYyyy(value: string): Date | null {
  const match = String(value ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const parsed = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(current);
      current = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(current);
      rows.push(row);
      row = [];
      current = "";
      continue;
    }
    current += ch;
  }
  row.push(current);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function normalizeMetricDate(rawValue: unknown): string {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return "";
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
}

async function fetchFluentFormLeads(startDate: string, endDate: string): Promise<FluentLead[]> {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T23:59:59.999Z`);
  const priorities = new Set(["low intent", "mid intent", "high intent"]);
  const leads: FluentLead[] = [];
  await Promise.all(
    FLUENT_FORM_TABS.map(async (tab) => {
      const url = `https://docs.google.com/spreadsheets/d/${FLUENT_FORM_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
      const response = await fetch(url, { headers: { Accept: "text/csv" } });
      if (!response.ok) return;
      const rows = parseCsv(await response.text());
      for (let i = 1; i < rows.length; i += 1) {
        const row = rows[i];
        const dateValue = String(row[0] ?? "").trim();
        const email = String(row[3] ?? "").trim().toLowerCase();
        const priority = String(row[10] ?? "").trim();
        const leadType = String(row[19] ?? "").trim().toUpperCase();
        if (!email || !priorities.has(priority.toLowerCase()) || (leadType !== "MQL" && leadType !== "SQL")) continue;
        const parsedDate = parseDdMmYyyy(dateValue);
        if (!parsedDate || parsedDate < start || parsedDate > end) continue;
        leads.push({
          date: dateValue,
          name: String(row[2] ?? "").trim(),
          email,
          company: String(row[4] ?? "").trim(),
          priority,
          lead_type: leadType,
          source_tab: tab
        });
      }
    })
  );
  return leads.sort((a, b) => (parseDdMmYyyy(b.date)?.getTime() ?? 0) - (parseDdMmYyyy(a.date)?.getTime() ?? 0));
}

async function fetchLemlistCampaignsLive(startDate: string, endDate: string) {
  const key = process.env.LEMLIST_API_KEY;
  if (!key) return null;
  const basicToken = Buffer.from(`:${key}`).toString("base64");
  const campaignResp = await fetch("https://api.lemlist.com/api/campaigns?perPage=500", {
    headers: { Accept: "application/json", Authorization: `Basic ${basicToken}` }
  });
  if (!campaignResp.ok) return null;
  const campaigns = ((await campaignResp.json()) as unknown[]).filter((row) => typeof row === "object" && row !== null) as LemlistCampaignListItem[];
  const activeCampaigns = campaigns.filter((campaign) => !Boolean(campaign.archived));
  const all: LemlistActivity[] = [];
  for (let page = 1; page <= 200; page += 1) {
    const response = await fetch(`https://api.lemlist.com/api/activities?perPage=200&page=${page}`, {
      headers: { Accept: "application/json", Authorization: `Basic ${basicToken}` }
    });
    if (!response.ok) break;
    const rows = (await response.json()) as LemlistActivity[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    const pageDates = rows.map((r) => normalizeMetricDate(r.createdAt)).filter(Boolean).sort();
    if (pageDates.length > 0 && pageDates[pageDates.length - 1] < startDate) break;
    if (rows.length < 200) break;
  }
  const countsByCampaign = new Map<string, { sent: number; opened: number; clicked: number; replied: number }>();
  for (const activity of all) {
    const date = normalizeMetricDate(activity.createdAt);
    if (!date || date < startDate || date > endDate) continue;
    const campaignId = String(activity.campaignId ?? activity.metaData?.campaignId ?? "").trim();
    const type = String(activity.type ?? activity.metaData?.type ?? "").trim().toLowerCase();
    if (!campaignId || !type) continue;
    const bucket = countsByCampaign.get(campaignId) ?? { sent: 0, opened: 0, clicked: 0, replied: 0 };
    if (type === "emailssent") bucket.sent += 1;
    if (type === "emailsopened") bucket.opened += 1;
    if (type === "emailsclicked") bucket.clicked += 1;
    if (type === "emailsreplied") bucket.replied += 1;
    countsByCampaign.set(campaignId, bucket);
  }
  return activeCampaigns
    .map((campaign) => {
      const campaignId = String(campaign._id ?? "").trim();
      if (!campaignId) return null;
      const c = countsByCampaign.get(campaignId) ?? { sent: 0, opened: 0, clicked: 0, replied: 0 };
      const sent = c.sent;
      return {
        campaign_name: String(campaign.name ?? campaignId),
        emails_sent: String(sent),
        opened: String(Math.min(c.opened, sent)),
        clicked: String(Math.min(c.clicked, sent)),
        open_rate: String(sent > 0 ? Math.min(1, c.opened / sent) : 0),
        replied: String(Math.min(c.replied, sent)),
        reply_rate: String(sent > 0 ? Math.min(1, c.replied / sent) : 0)
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => a.campaign_name.localeCompare(b.campaign_name));
}

export async function GET(request: NextRequest, { params }: { params: { path: string[] } }) {
  const routePath = (params.path ?? []).join("/");
  const query = Object.fromEntries(request.nextUrl.searchParams.entries()) as QueryLike & { source?: string; limit?: string };
  const { startDate, endDate } = getDateRange(query);

  if (routePath === "health") {
    const ok = (await safeQuery("select 1 as ok", [], [{ ok: 0 }])).length > 0;
    return NextResponse.json({ ok: true, dbUp: ok });
  }
  if (routePath === "sources/status") return NextResponse.json(await safeQuery(`select source_name, last_successful_sync_at, last_error from source_sync_status order by source_name`, [], []));
  if (routePath === "kpi/overview") {
    const rows = await safeQuery<KPI>(`select coalesce(sum(spend),0) as spend, coalesce(sum(impressions),0) as impressions, coalesce(sum(clicks),0) as clicks, coalesce(sum(leads),0) as leads, coalesce(sum(conversions),0) as conversions, case when sum(impressions)>0 then sum(clicks)::numeric/sum(impressions) else 0 end as ctr from fact_campaign_performance where metric_date between $1 and $2`, [startDate, endDate], [ZERO_KPI]);
    return NextResponse.json(rows[0] ?? ZERO_KPI);
  }
  if (routePath === "campaigns/summary") {
    const sql = query.source
      ? `select source,campaign_name,min(metric_date)::text as start_date,max(metric_date)::text as end_date,coalesce(sum(spend),0) as spend,coalesce(sum(impressions),0) as impressions,coalesce(sum(clicks),0) as clicks,coalesce(sum(leads),0) as form_submissions,case when sum(impressions)>0 then sum(clicks)::numeric/sum(impressions) else 0 end as ctr from campaign_performance_view where source=$1 and metric_date between $2 and $3 group by source,campaign_name order by spend desc,campaign_name asc`
      : `select source,campaign_name,min(metric_date)::text as start_date,max(metric_date)::text as end_date,coalesce(sum(spend),0) as spend,coalesce(sum(impressions),0) as impressions,coalesce(sum(clicks),0) as clicks,coalesce(sum(leads),0) as form_submissions,case when sum(impressions)>0 then sum(clicks)::numeric/sum(impressions) else 0 end as ctr from campaign_performance_view where metric_date between $1 and $2 group by source,campaign_name order by spend desc,campaign_name asc`;
    const rows = await safeQuery(sql, query.source ? [query.source, startDate, endDate] : [startDate, endDate], []);
    return NextResponse.json(rows);
  }
  if (routePath === "channels/breakdown") return NextResponse.json(await safeQuery(`select source,sum(spend) as spend,sum(impressions) as impressions,sum(clicks) as clicks,sum(leads) as leads,sum(conversions) as conversions from fact_campaign_performance where metric_date between $1 and $2 group by source order by spend desc`, [startDate, endDate], []));
  if (routePath === "funnel") {
    const rows = await safeQuery(`select (select coalesce(sum(clicks),0) from fact_campaign_performance where metric_date between $1 and $2) as ad_clicks,(select count(*) from fact_forms where submitted_at::date between $1 and $2) as form_submissions,(select coalesce(sum(sends),0) from fact_email_outreach where metric_date between $1 and $2) as emails_sent,(select count(*) from map_email_to_crm where matched=true) as crm_matched_contacts`, [startDate, endDate], [{ ad_clicks: "0", form_submissions: "0", emails_sent: "0", crm_matched_contacts: "0" }]);
    return NextResponse.json(rows[0]);
  }
  if (routePath === "ga4/campaigns") return NextResponse.json(await safeQuery(`with ga4_campaign_sources as (select source_campaign_id,coalesce(payload->>'source','unknown') as traffic_source,min(metric_date)::text as start_date,max(metric_date)::text as end_date from raw_campaign_payloads where source='ga4' and metric_date between $1 and $2 group by source_campaign_id,coalesce(payload->>'source','unknown')),ga4_leads as (select source_campaign_id,coalesce(form_payload->>'source','unknown') as traffic_source,coalesce(sum(coalesce((form_payload->>'form_submissions')::bigint,1)),0) as leads from fact_forms where source='ga4' and submitted_at::date between $1 and $2 and lower(coalesce(form_payload->>'event_name',form_payload->>'event',''))='lead_generated_all_sites' group by source_campaign_id,coalesce(form_payload->>'source','unknown')) select c.source_campaign_id,c.traffic_source,c.start_date,c.end_date,coalesce(l.leads,0) as leads from ga4_campaign_sources c left join ga4_leads l on l.source_campaign_id=c.source_campaign_id and l.traffic_source=c.traffic_source where coalesce(l.leads,0)>0 order by leads desc,c.source_campaign_id asc limit 200`, [startDate, endDate], []));
  if (routePath === "ga4/lead-sources") return NextResponse.json(await safeQuery(`select coalesce(form_payload->>'source','unknown') as source,coalesce(sum(coalesce((form_payload->>'form_submissions')::bigint,1)),0)::text as submissions from fact_forms where source='ga4' and submitted_at::date between $1 and $2 and lower(coalesce(form_payload->>'event_name',form_payload->>'event',''))='lead_generated_all_sites' group by coalesce(form_payload->>'source','unknown') order by sum(coalesce((form_payload->>'form_submissions')::bigint,1)) desc`, [startDate, endDate], []));
  if (routePath === "lemlist/campaigns") {
    const liveRows = await fetchLemlistCampaignsLive(startDate, endDate);
    if (liveRows) return NextResponse.json(liveRows);
    return NextResponse.json(await safeQuery(`with active_campaigns as (select distinct on (source_campaign_id) source_campaign_id,coalesce(nullif(payload->>'name',''),nullif(campaign_name,''),replace(source_campaign_id,'lemlist:','')) as campaign_name from raw_campaign_payloads where source='lemlist' and (source_campaign_id like 'lemlist:cam_%' or coalesce(payload->>'campaignId','') like 'cam_%' or coalesce(payload->>'_id','') like 'cam_%') order by source_campaign_id,metric_date desc), perf as (select source_campaign_id,coalesce(sum(impressions),0) as emails_sent,coalesce(sum(clicks),0) as opened,coalesce(sum(conversions),0) as clicked,coalesce(sum(leads),0) as replied from fact_campaign_performance where source='lemlist' and metric_date between $1 and $2 group by source_campaign_id) select ac.campaign_name,coalesce(p.emails_sent,0)::text as emails_sent,coalesce(p.opened,0)::text as opened,coalesce(p.clicked,0)::text as clicked,(case when coalesce(p.emails_sent,0)>0 then least(1,coalesce(p.opened,0)::numeric/nullif(coalesce(p.emails_sent,0)::numeric,0)) else 0 end)::text as open_rate,coalesce(p.replied,0)::text as replied,(case when coalesce(p.emails_sent,0)>0 then least(1,coalesce(p.replied,0)::numeric/nullif(coalesce(p.emails_sent,0)::numeric,0)) else 0 end)::text as reply_rate from active_campaigns ac left join perf p on p.source_campaign_id=ac.source_campaign_id order by ac.campaign_name asc`, [startDate, endDate], []));
  }
  if (routePath === "hubspot/details") {
    const [summaryRows, lifecycleRows, ownerRows] = await Promise.all([
      safeQuery(`select count(*) as total_emails,count(*) filter (where matched=true) as matched_emails,count(*) filter (where matched=false) as unmatched_emails,count(*) filter (where matched=true and lower(coalesce(lifecycle_stage,'')) in ('opportunity','customer')) as deals_created,count(*) filter (where matched=true and lower(coalesce(lifecycle_stage,'')) in ('marketingqualifiedlead','mql')) as mql_count,count(*) filter (where matched=true and lower(coalesce(lifecycle_stage,'')) in ('salesqualifiedlead','sql')) as sql_count,count(*) filter (where matched=true and lower(coalesce(lifecycle_stage,''))='customer') as customer_count,count(*) filter (where matched=true and nullif(trim(coalesce(owner_name,'')),'') is not null) as assigned_owner_count from map_email_to_crm where last_seen_at::date between $1 and $2`, [startDate, endDate], [{ total_emails: "0", matched_emails: "0", unmatched_emails: "0", deals_created: "0", mql_count: "0", sql_count: "0", customer_count: "0", assigned_owner_count: "0" }]),
      safeQuery(`select case when lower(coalesce(lifecycle_stage,'')) in ('subscriber') then 'Subscriber' when lower(coalesce(lifecycle_stage,'')) in ('lead') then 'Lead' when lower(coalesce(lifecycle_stage,'')) in ('marketingqualifiedlead','mql') then 'MQL' when lower(coalesce(lifecycle_stage,'')) in ('salesqualifiedlead','sql') then 'SQL' when lower(coalesce(lifecycle_stage,'')) in ('opportunity') then 'Opportunity' when lower(coalesce(lifecycle_stage,'')) in ('customer') then 'Customer' else 'Other' end as lifecycle_stage,count(*) as contacts from map_email_to_crm where matched=true and last_seen_at::date between $1 and $2 group by 1 order by contacts desc limit 5`, [startDate, endDate], []),
      safeQuery(`select coalesce(nullif(owner_name,''),'Unassigned') as owner_name,count(*) as matched_contacts,count(*) filter (where lower(coalesce(lifecycle_stage,'')) in ('marketingqualifiedlead','mql')) as mql,count(*) filter (where lower(coalesce(lifecycle_stage,'')) in ('salesqualifiedlead','sql')) as sql,count(*) filter (where lower(coalesce(lifecycle_stage,''))='customer') as customers from map_email_to_crm where matched=true and last_seen_at::date between $1 and $2 group by 1 order by matched_contacts desc,owner_name asc limit 20`, [startDate, endDate], [])
    ]);
    return NextResponse.json({ summary: summaryRows[0], lifecycle: lifecycleRows, owners: ownerRows });
  }
  if (routePath === "matches/lemlist-hubspot") return NextResponse.json(await safeQuery(`select email, hubspot_contact_id, matched, lifecycle_stage, owner_name, last_seen_at from map_email_to_crm order by last_seen_at desc limit 500`, [], []));
  if (routePath === "hubspot/matched-leads") return NextResponse.json(await safeQuery(`with latest_hubspot as (select distinct on (email) email,nullif(trim(coalesce(payload->>'name','') || case when coalesce(payload->>'firstname','') <> '' or coalesce(payload->>'lastname','') <> '' then ' ' || trim(coalesce(payload->>'firstname','') || ' ' || coalesce(payload->>'lastname','')) else '' end),'') as lead_name,nullif(coalesce(payload->>'dealstage',payload->>'deal_stage',payload->>'hs_deal_stage',payload->>'lifecyclestage',payload->>'lifecycle_stage',''),'') as deal_stage from (select lower(trim(coalesce(payload->>'email',payload->>'contact_email',payload->>'hs_email',''))) as email,payload,metric_date from raw_campaign_payloads where source='hubspot') hubspot_raw where email <> '' order by email,metric_date desc) select coalesce(h.lead_name, split_part(m.email, '@', 1)) as lead_name,m.email,coalesce(h.deal_stage,m.lifecycle_stage,'unknown') as deal_stage,coalesce(m.owner_name,'Unassigned') as owner_name,m.last_seen_at from map_email_to_crm m left join latest_hubspot h on h.email=m.email where m.matched=true and lower(split_part(m.email,'@',2)) not in ('disrupt.com','purevpn.com','puresquare.com') and m.last_seen_at::date between $1 and $2 order by m.last_seen_at desc limit 200`, [startDate, endDate], []));
  if (routePath === "fluentform/leads") {
    try {
      const leads = await fetchFluentFormLeads(startDate, endDate);
      return NextResponse.json({ summary: { total: String(leads.length), mql: String(leads.filter((l) => l.lead_type === "MQL").length), sql: String(leads.filter((l) => l.lead_type === "SQL").length) }, mql: leads.filter((l) => l.lead_type === "MQL"), sql: leads.filter((l) => l.lead_type === "SQL") });
    } catch {
      return NextResponse.json({ summary: { total: "0", mql: "0", sql: "0" }, mql: [], sql: [] });
    }
  }
  if (routePath === "fluentform/hubspot-matches") {
    try {
      const leads = await fetchFluentFormLeads(startDate, endDate);
      const emailToLead = new Map<string, FluentLead>();
      leads.forEach((lead) => { if (!emailToLead.has(lead.email)) emailToLead.set(lead.email, lead); });
      const emails = Array.from(emailToLead.keys());
      if (emails.length === 0) return NextResponse.json({ summary: { checked: 0, matched: 0 }, matched: [] });
      const hubspotRows = await safeQuery<{ email: string; hubspot_contact_id: string | null; lifecycle_stage: string | null; owner_name: string | null }>(`select email, hubspot_contact_id, lifecycle_stage, owner_name from hubspot_contacts where email = any($1::text[])`, [emails], []);
      const matched = hubspotRows.map((row) => {
        const lead = emailToLead.get(String(row.email).toLowerCase());
        if (!lead) return null;
        return { name: lead.name || lead.email.split("@")[0], email: lead.email, priority: lead.priority, lead_type: lead.lead_type, source_tab: lead.source_tab, hubspot_contact_id: row.hubspot_contact_id, lifecycle_stage: row.lifecycle_stage ?? "unknown", owner_name: row.owner_name ?? "Unassigned" };
      }).filter((row): row is NonNullable<typeof row> => row !== null).sort((a, b) => a.email.localeCompare(b.email));
      return NextResponse.json({ summary: { checked: emails.length, matched: matched.length }, matched });
    } catch {
      return NextResponse.json({ summary: { checked: 0, matched: 0 }, matched: [] });
    }
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
