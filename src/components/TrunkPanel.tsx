import { CheckCircle2, LockKeyhole, RadioTower, ShieldCheck, Signal, TriangleAlert } from "lucide-react";
import type { TrunkStatus } from "../lib/domain";
import { formatPhoneNumber } from "../lib/domain";

export function TrunkPanel({ trunk }: { trunk: TrunkStatus }) {
  const live = trunk.mode === "freeswitch" && trunk.configured;
  return (
    <div className="trunk-view">
      <section className="trunk-hero">
        <div>
          <span className="eyebrow"><RadioTower size={14} /> Singtel CPaaS</span>
          <h1>Internet SIP trunk</h1>
          <p>Account authentication, TLS signaling, and SRTP media are configured separately from the voice-flow control plane.</p>
        </div>
        <div className={`gateway-state ${live ? "gateway-state--live" : "gateway-state--safe"}`}>
          <span>{live ? <CheckCircle2 size={16} /> : <ShieldCheck size={16} />}</span>
          <div><strong>{live ? "Gateway enabled" : "Simulator enabled"}</strong><small>{live ? "FreeSWITCH can originate calls" : "No SIP INVITEs leave this machine"}</small></div>
        </div>
      </section>
      <section className="trunk-summary">
        <div><span>Account</span><strong>{trunk.trunkUsername}</strong></div>
        <div><span>Endpoint</span><strong>{trunk.endpoint}</strong></div>
        <div><span>Capacity</span><strong>{trunk.activeCalls} / {trunk.maxConcurrentCalls} calls</strong></div>
        <div><span>Signaling</span><strong>TLS {trunk.signalingPort}</strong></div>
      </section>
      <section className="trunk-detail-grid">
        <article className="trunk-detail">
          <Signal size={18} />
          <h2>Media profile</h2>
          <dl><div><dt>Codecs</dt><dd>{trunk.codecs.join(", ")}</dd></div><div><dt>Media</dt><dd>{trunk.media}</dd></div><div><dt>DTMF</dt><dd>RFC2833</dd></div><div><dt>Classifier</dt><dd>{trunk.classifierMode === "openai" ? "OpenAI structured output" : "Fast local rules"}</dd></div></dl>
        </article>
        <article className="trunk-detail">
          <LockKeyhole size={18} />
          <h2>Network policy</h2>
          <dl><div><dt>Transport</dt><dd>TLS 1.2 or newer</dd></div><div><dt>Certificate</dt><dd>Singtel CA bundle</dd></div><div><dt>NAT</dt><dd>STUN if gateway is behind NAT</dd></div></dl>
        </article>
        <article className="trunk-detail trunk-detail--numbers">
          <h2>Approved caller IDs</h2>
          <div className="number-grid">{trunk.callerIds.map((id) => <span key={id}>{formatPhoneNumber(id)}</span>)}</div>
          <p><TriangleAlert size={14} /> {formatPhoneNumber(trunk.reservedCallerId)} remains reserved for Retell.</p>
        </article>
      </section>
      <section className="gateway-checklist">
        <h2>Production gateway checklist</h2>
        <div><i className="check-dot check-dot--ok" /> Store SIP and ESL passwords in the deployment secret manager.</div>
        <div><i className="check-dot check-dot--ok" /> Install the supplied Singtel CA certificate on the FreeSWITCH host.</div>
        <div><i className="check-dot check-dot--draft" /> Add the gateway public IP to the CPaaS whitelist before enabling live mode.</div>
      </section>
    </div>
  );
}
