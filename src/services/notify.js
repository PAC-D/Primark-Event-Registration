// Registration confirmation email via a Power Automate "When an HTTP request is received" trigger.
// Best effort: failures are logged, never thrown — a dead webhook must not fail a registration.

const TIMEOUT_MS = 6000;

// The confirmation payload posted to the flow. Field names are what the flow's email action maps.
export function registrationConfirmation({ eventTitle, payload, orgNames }) {
  return {
    type: 'registration_confirmation',
    name: payload.name,
    email: payload.email,
    phone: payload.phone,
    designation: payload.designation,
    from_type: payload.from_type,
    organisation_name: payload.organisation_name ?? null,
    organisations: orgNames,
    event_name: 'Primark Carton Nomination Program',
    event_subtitle: eventTitle,
    event_date: 'Nov 04, 2026',
    event_time: '9:00 AM – 3:30 PM (GMT+6)',
  };
}

export async function notifyRegistration(config, details) {
  const url = config.powerAutomateWebhookUrl;
  if (!url) return; // feature disabled
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(details),
      signal: controller.signal,
    });
    if (!res.ok) console.warn(`Power Automate webhook responded ${res.status} for ${details.email}`);
  } catch (error) {
    console.warn(`Power Automate webhook failed for ${details.email}:`, error.message);
  } finally {
    clearTimeout(timeout);
  }
}
