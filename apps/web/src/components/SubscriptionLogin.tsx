import { Check, CircleAlert, Copy, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { FormEvent, useState } from "react";
import type { ProviderOption, SubscriptionAuthFlow } from "../types";

export function SubscriptionLogin({ provider, flow, busy, onStart, onAnswer, onCancel }: { provider: ProviderOption; flow: SubscriptionAuthFlow | null; busy: boolean; onStart: () => void; onAnswer: (promptId: string, value: string) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const [answering, setAnswering] = useState(false);
  const [copiedDeviceCodeId, setCopiedDeviceCodeId] = useState<number | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!flow?.prompt || !value.trim()) return;
    setAnswering(true);
    try { await onAnswer(flow.prompt.id, value); setValue(""); }
    finally { setAnswering(false); }
  }
  const prompt = flow?.prompt;
  return <div className="subscription-login">
    {!flow && <div className="subscription-idle">{provider.usingSubscription ? <><div><Check size={16} /><span><strong>Subscription connected</strong><small>{provider.subscriptionName}</small></span></div><button className="secondary-button" disabled={busy} onClick={onStart}><RefreshCw size={14} /><span>Reconnect</span></button></> : <><div><ExternalLink size={16} /><span><strong>Subscription sign-in</strong><small>{provider.subscriptionLoginLabel || provider.subscriptionName}</small></span></div><button className="primary-button" disabled={busy} onClick={onStart}>{busy ? <LoaderCircle size={14} /> : <ExternalLink size={14} />}Start sign-in</button></>}</div>}
    {flow && <>
      <div className={`subscription-state ${flow.status}`}>
        {flow.status === "pending" && <LoaderCircle size={15} />}{flow.status === "success" && <Check size={15} />}{(flow.status === "error" || flow.status === "cancelled") && <CircleAlert size={15} />}
        <span>{flow.status === "pending" ? "Subscription sign-in in progress" : flow.status === "success" ? "Subscription connected" : flow.status === "cancelled" ? "Subscription sign-in cancelled" : flow.error || "Subscription sign-in failed"}</span>
      </div>
      {flow.events.length > 0 && <div className="subscription-events">{flow.events.map((event) => <div className={`subscription-event ${event.type}`} key={event.id}>
        {event.type === "auth_url" && <><p>{event.instructions || "Open the provider sign-in page."}</p><a href={event.url} target="_blank" rel="noreferrer"><ExternalLink size={13} />Open sign-in page</a></>}
        {event.type === "device_code" && <><p>Enter this code on the provider page.</p><div className="device-code"><code>{event.userCode}</code><button aria-label={copiedDeviceCodeId === event.id ? "Device code copied" : "Copy device code"} title={copiedDeviceCodeId === event.id ? "Device code copied" : "Copy device code"} onClick={() => void navigator.clipboard.writeText(event.userCode || "").then(() => { setCopiedDeviceCodeId(event.id); window.setTimeout(() => setCopiedDeviceCodeId((current) => current === event.id ? null : current), 1500); })}>{copiedDeviceCodeId === event.id ? <Check size={13} /> : <Copy size={13} />}<span>{copiedDeviceCodeId === event.id ? "Copied" : "Copy"}</span></button></div><a href={event.verificationUri} target="_blank" rel="noreferrer"><ExternalLink size={13} />Open verification page</a></>}
        {(event.type === "info" || event.type === "progress") && <><p>{event.message}</p>{event.links?.map((link) => <a href={link.url} target="_blank" rel="noreferrer" key={link.url}><ExternalLink size={13} />{link.label || "Open link"}</a>)}</>}
      </div>)}</div>}
      {prompt?.type === "select" && <div className="subscription-prompt"><strong>{prompt.message}</strong><div className="subscription-options">{prompt.options?.map((option) => <button disabled={answering} onClick={() => void onAnswer(prompt.id, option.id)} key={option.id}><span>{option.label}</span>{option.description && <small>{option.description}</small>}</button>)}</div></div>}
      {prompt && prompt.type !== "select" && <form className="subscription-prompt" onSubmit={(event) => void submit(event)}><label><strong>{prompt.message}</strong><input autoFocus type={prompt.type === "secret" ? "password" : "text"} value={value} placeholder={prompt.placeholder} onChange={(event) => setValue(event.target.value)} /></label><button className="primary-button" disabled={answering || !value.trim()}>{answering && <LoaderCircle size={14} />}Continue</button></form>}
      <div className="subscription-actions">{flow.status === "pending" ? <button className="secondary-button" onClick={onCancel}>Cancel sign-in</button> : flow.status !== "success" && <button className="secondary-button" onClick={onStart}>Try again</button>}</div>
    </>}
  </div>;
}
