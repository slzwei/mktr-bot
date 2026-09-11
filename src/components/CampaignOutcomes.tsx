import { useEffect, useState } from "react";
import { Download, Save } from "lucide-react";
import { api } from "../lib/api";
import type { CampaignDetail, OutcomeDeliverySummary } from "../lib/domain";

export function CampaignOutcomes({ campaign, canManage, onSaved }: { campaign: CampaignDetail; canManage: boolean; onSaved(): Promise<void> }) {
  const [url, setUrl] = useState(campaign.outcomeWebhookUrl ?? "");
  const [deliveries, setDeliveries] = useState<OutcomeDeliverySummary[]>([]);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => api.outcomeDeliveries(campaign.id).then((result) => { if (active) { setDeliveries(result.deliveries); setConfigured(result.configured); } }).catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : "Could not load outcome deliveries."); });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [campaign.id]);
  const save = async () => {
    setBusy(true); setMessage(""); setError("");
    try {
      const saved = await api.setOutcomeWebhook(campaign.id, url.trim() || null);
      setUrl(saved.outcomeWebhookUrl ?? ""); await onSaved();
      setMessage(saved.outcomeWebhookUrl ? "Webhook saved for future call completions." : "Webhook disabled for future call completions.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save the webhook."); }
    finally { setBusy(false); }
  };
  return <section className="campaign-outcomes" aria-label="Campaign outcomes and export">
    <div className="campaign-outcomes-header"><h3>Outcomes and export</h3><a className="secondary-button" href={`/api/campaigns/${campaign.id}/export.csv`} download><Download size={15} /> Export campaign CSV</a></div>
    <p>The CSV contains one row per call attempt, including attempts still in progress.</p>
    <details><summary>Outcome webhook</summary>
      {!configured && <p>The administrator must configure an approved host and signing secret on the server before enabling delivery.</p>}
      <label>HTTPS outcome webhook<input value={url} type="url" placeholder="https://approved.example/voice-outcomes" readOnly={!canManage} onChange={(event) => setUrl(event.target.value)} /></label>
      {canManage ? <button className="secondary-button" onClick={save} disabled={busy || !configured && Boolean(url.trim())}><Save size={15} /> Save outcome webhook</button> : <p>An administrator can change this campaign’s webhook.</p>}
      <p>New completions use the saved endpoint. Previously queued deliveries keep their endpoint and may retry after this setting is disabled. Failed deliveries require recipient review using the delivery ID.</p>
      {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
      <div className="campaign-table-scroll"><table><thead><tr><th>Delivery ID</th><th>Call ID</th><th>Status</th><th>Attempts</th><th>Detail</th></tr></thead><tbody>{deliveries.map((delivery) => <tr key={delivery.id}><td>{delivery.id}</td><td>{delivery.callId}</td><td>{delivery.status}</td><td>{delivery.attempts}</td><td>{delivery.lastError ?? (delivery.status === "delivered" ? "Acknowledged by recipient" : "Awaiting delivery")}</td></tr>)}</tbody></table></div>
      {deliveries.length === 0 && <p>No queued deliveries.</p>}
    </details>
  </section>;
}
