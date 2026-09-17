// Event-wide settings shared by the browser (/shared/constants.js) and the server. Keep it dependency-free.
// The database functions in supabase/migrations enforce the same seat limit; change both together.

// Maximum people per organisation per side ("from supplier" / "from factory").
export const SEAT_LIMIT = 2;

// All dates and times are shown and exported in the event's local time.
export const EVENT_TIME_ZONE = 'Asia/Dhaka';
