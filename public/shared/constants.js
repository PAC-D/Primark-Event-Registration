// Event-wide settings shared by the browser (/shared/constants.js) and the server. Keep it dependency-free.
// The database functions in supabase/migrations enforce the same seat limits; change both together.

// Maximum attendees charged per organisation of each kind ("attending from" side).
export const SEAT_LIMITS = { supplier: 2, factory: 1 };

// All dates and times are shown and exported in the event's local time.
export const EVENT_TIME_ZONE = 'Asia/Dhaka';

// Organisation choices for attendees who register as "Other". Keep this list as the single place to edit.
// The last entry, "Other", reveals a free-text input in the form.
export const ORGANISATION_OPTIONS = [
  'Primark Limited',
  'Associated British Foods',
  'Maersk Bangladesh',
  'WAC - Bangladesh',
  'Uniglory Packaging Industries Limited',
  'Reflex Packaging Ltd.',
  'Union Label and Accessories Limited',
  'Epyllion Limited',
  'Youngshine Packtrims Limited',
  'Other',
];

// Photo uploads: JPEG or PNG, at most 1 MiB. Enforced in the form, the /api/photos route
// (magic bytes) and the storage bucket settings.
export const PHOTO_MAX_BYTES = 1024 * 1024;
