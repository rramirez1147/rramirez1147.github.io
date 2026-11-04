// The page friends open from their invitation link. They can say when they're free and, once the
// time is set, let the host know if they can't make it, all without the app or an account.
//
// How it works: the link carries a secret token. The guest signs in anonymously, then
// claim_invitation links that anonymous session to their spot in the event. From then on the
// database's privacy rules treat them like any participant: they can see the event and their own
// availability, never anyone else's.
//
// The Supabase address and publishable key below are meant to be public.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
    "https://xkfbnlsjqjyamiikmxki.supabase.co",
    "sb_publishable_UVXvc5Tixtvu9VbKxSlnyg_4Y68-FXx",
);

const token = new URLSearchParams(location.search).get("t");
const app = document.getElementById("app");

const state = {
    invitation: null,   // what get_invitation returns
    participantID: null,
    event: null,
    windows: [],        // your saved availability
    candidates: [],
    notice: null,       // a message shown after saving
    items: [],          // the Bring list
    updates: [],        // messages from the host
    names: new Map(),   // participant id → name, for the Bring list
};

start();

// MARK: - Flow

async function start() {
    if (!token) return showProblem("This link is incomplete. Ask the organizer to send it again.");

    const { data, error } = await supabase.rpc("get_invitation", { p_token: token });
    if (error || !data?.length) {
        return showProblem("This invitation isn’t valid anymore. It may have been replaced, or the event has ended.");
    }
    state.invitation = data[0];

    // Coming back on the same browser: pick up where they left off.
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
        try {
            await claim(null);
            return showMain();
        } catch {
            // Fall through to asking for their name.
        }
    }
    showWelcome();
}

async function claim(name) {
    const { data, error } = await supabase.rpc("claim_invitation", { p_token: token, p_display_name: name });
    if (error) throw error;
    state.participantID = data;
    await load();
}

async function load() {
    const eventID = state.invitation.event_id;
    const [event, windows, candidates, items, updates, people] = await Promise.all([
        supabase.from("events").select("*").eq("id", eventID).single(),
        supabase.from("availability_windows").select("start_time, end_time, availability_type")
            .eq("participant_id", state.participantID),
        supabase.from("candidate_slots").select("*").eq("event_id", eventID).in("status", ["active", "finalized"])
            .order("is_recommended", { ascending: false }).order("ranking_score", { ascending: false }),
        supabase.from("event_items").select("id, title, claimed_by").eq("event_id", eventID).order("created_at"),
        supabase.from("event_updates").select("id, body, created_at").eq("event_id", eventID).order("created_at", { ascending: false }),
        supabase.from("event_participants").select("id, display_name, participation_status").eq("event_id", eventID),
    ]);
    for (const result of [event, windows, candidates]) if (result.error) throw result.error;
    // The Bring list and updates are extras; leave them empty rather than failing.
    state.items = items.data ?? [];
    state.updates = updates.data ?? [];
    state.names = new Map((people.data ?? []).map((p) => [p.id, p.display_name || "Guest"]));
    state.participation = (people.data ?? []).find((p) => p.id === state.participantID)?.participation_status;

    state.event = event.data;
    state.windows = windows.data.filter((w) => w.availability_type === "available");
    state.candidates = candidates.data;
}

// MARK: - Screens

function showProblem(message) {
    render(el("h1", {}, "Hmm."), el("p", { class: "lead" }, message));
}

// The host already typed the guest's name, so greet them by it. "Not Sam?" lets them change it.
function showWelcome() {
    const inv = state.invitation;
    const known = (inv.guest_name || "").trim();
    const name = el("input", { type: "text", placeholder: "Your name", autocomplete: "given-name", maxlength: "60", value: known });
    const nameCard = el("div", { class: "card", hidden: Boolean(known) }, el("div", { class: "row" }, name));
    const button = el("button", { class: "primary", disabled: !known }, "Continue");
    const problem = el("p", { class: "footnote error", hidden: true });
    const notMe = el("button", { type: "button", class: "link" }, `Not ${known}?`);
    notMe.addEventListener("click", () => {
        name.value = "";
        nameCard.hidden = false;
        notMe.hidden = true;
        button.disabled = true;
        name.focus();
    });

    name.addEventListener("input", () => { button.disabled = !name.value.trim(); });
    button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "One moment…";
        problem.hidden = true;
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                const { error } = await supabase.auth.signInAnonymously();
                if (error) throw error;
            }
            // Keeping the host's spelling sends no name, so it isn't changed.
            const typed = name.value.trim();
            await claim(typed && typed !== known ? typed : null);
            showMain();
        } catch (error) {
            problem.textContent = friendly(error);
            problem.hidden = false;
            button.disabled = false;
            button.textContent = "Continue";
        }
    });

    render(
        el("h1", {}, known ? `Hi ${known}!` : inv.title),
        el("p", { class: "lead" }, known
            ? `${inv.organizer_name || "A friend"} invited you to “${inv.title}” and wants to find a time that works for everyone.`
            : `${inv.organizer_name || "A friend"} invited you and wants to find a time that works for everyone.`),
        detailsCard(inv),
        nameCard,
        known ? notMe : el("p", { class: "footnote" }, "So the organizer knows who responded. You don’t need an account or the app."),
        problem,
        button,
    );
    if (!known) name.focus();
}

function showMain() {
    const event = state.event;
    const parts = [el("h1", {}, event.title), detailsCard(event)];

    if (state.notice) parts.push(el("div", { class: "banner success" }, state.notice));

    if (event.status === "cancelled") {
        parts.push(el("div", { class: "banner" }, "This event was cancelled."));
    } else if (event.status === "confirmed") {
        // Once there's a time: the time, whether you can make it, and then the extras.
        parts.push(...confirmedSection());
        if (state.updates.length) parts.push(...updatesSection());
        if (state.items.length) parts.push(...bringSection());
    } else {
        // Before then, just the one thing to do: say when you're free.
        parts.push(...availabilitySection());
    }
    render(...parts);
}

function updatesSection() {
    return [
        el("h2", {}, "Updates from the Host"),
        el("div", { class: "card" }, ...state.updates.map((u) => el("div", { class: "row stacked" },
            el("span", {}, u.body),
            el("span", { class: "footnote", style: "margin:0" }, new Date(u.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })),
        ))),
    ];
}

// Things to bring. Tap an open item to bring it, or your own to give it back.
function bringSection() {
    const rows = state.items.map((item) => {
        const mine = item.claimed_by === state.participantID;
        const taken = item.claimed_by && !mine;
        const button = el("button", { type: "button", class: "small", disabled: taken }, mine ? "You’re bringing it" : taken ? state.names.get(item.claimed_by) ?? "Taken" : "I’ll bring it");
        if (!taken) button.addEventListener("click", () => claimItem(item, !mine));
        return el("div", { class: "row" }, el("span", { class: "label" }, item.title), button);
    });
    return [
        el("h2", {}, "Bring"),
        el("div", { class: "card" }, ...rows),
        el("p", { class: "footnote" }, "Tap an item to say you’ll bring it."),
    ];
}

async function claimItem(item, claim) {
    const { error } = await supabase.from("event_items")
        .update({ claimed_by: claim ? state.participantID : null })
        .eq("id", item.id);
    state.notice = error ? "Someone may have just taken that one. Try another." : claim ? `Thanks for bringing ${item.title.toLowerCase()}!` : "Okay, it’s open for someone else.";
    await load();
    showMain();
}

function detailsCard(event) {
    const rows = [
        row("Dates", dateRange(event.search_start, event.search_end)),
        row("Length", duration(event.duration_minutes)),
    ];
    // After the answer-by time, the host plans with whoever answered.
    const answering = ["draft", "awaiting_availability", "recommendation_ready"].includes(event.status);
    if (event.respond_by && answering && new Date(event.respond_by) > new Date()) {
        rows.push(row("Answer By", new Date(event.respond_by).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })));
    }
    if (event.location) {
        if (event.latitude != null && event.longitude != null) {
            // Apple Maps opens the Maps app on iPhone and a web map elsewhere.
            const url = `https://maps.apple.com/?ll=${event.latitude},${event.longitude}&q=${encodeURIComponent(event.location)}`;
            const link = el("a", { href: url, target: "_blank", rel: "noopener" }, event.location);
            rows.push(el("div", { class: "row" }, el("span", { class: "label" }, "Location"), el("span", { class: "value" }, link)));
        } else {
            rows.push(row("Location", event.location));
        }
    }
    if (event.description) rows.push(el("div", { class: "row muted" }, event.description));
    return el("div", { class: "card" }, ...rows);
}

function confirmedSection() {
    const final = state.candidates.find((c) => c.id === state.event.finalized_candidate_id);
    const parts = [
        el("h2", {}, "It’s Set"),
        el("div", { class: "card" }, el("div", { class: "row" },
            el("strong", {}, final ? slotText(final) : "The organizer has picked a time."),
        )),
    ];
    if (final) {
        parts.push(...rsvpSection());
        const link = el("a", { class: "primary button", href: calendarFile(state.event, final), download: "availia-event.ics" }, "Add to Calendar");
        parts.push(link);
    }
    return parts;
}

// Everyone who answered is counted as going. One button lets the host know if you can't make it.
function rsvpSection() {
    const out = state.participation === "not_attending";
    const button = el("button", { type: "button", class: "plain" }, out ? "I Can Make It After All" : "Can’t Make It");
    button.addEventListener("click", () => rsvp(out ? "attending" : "not_attending"));
    return [
        el("p", { class: "lead" }, out ? "The host knows you can’t make it." : "You’re going. See you there!"),
        button,
    ];
}

async function rsvp(value) {
    const { error } = await supabase.from("event_participants")
        .update({ participation_status: value })
        .eq("id", state.participantID);
    state.notice = error ? friendly(error) : value === "attending" ? "See you there!" : value === "not_attending" ? "Thanks for letting them know." : "Saved.";
    await load();
    showMain();
}

// A calendar file (.ics) for the confirmed time. iPhone and Mac open it straight into Calendar.
function calendarFile(event, slot) {
    const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const escape = (text) => String(text ?? "").replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Availia//EN",
        "BEGIN:VEVENT",
        `UID:${slot.id}@availia`,
        `DTSTAMP:${stamp(new Date().toISOString())}`,
        `DTSTART:${stamp(slot.start_time)}`,
        `DTEND:${stamp(slot.end_time)}`,
        `SUMMARY:${escape(event.title)}`,
        event.location ? `LOCATION:${escape(event.location)}` : null,
        event.description ? `DESCRIPTION:${escape(event.description)}` : null,
        "END:VEVENT",
        "END:VCALENDAR",
    ].filter(Boolean);
    return URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/calendar" }));
}

// Parts of the day, as minutes after midnight. Morning starts at midnight and Evening runs to
// midnight, so trimming them to the event's hours covers early and late events. Matches the app.
const dayParts = [["Morning", 0, 720], ["Afternoon", 720, 1020], ["Evening", 1020, 1440]];

// The event's hours: the host's preferred times, or 8 AM–10 PM.
function allowedMinutes(event) {
    const range = event.preferred_time_ranges?.[0];
    return range && range.end_minute > range.start_minute ? [range.start_minute, Math.min(range.end_minute, 1440)] : [480, 1320];
}

// The parts of the day inside the event's hours, trimmed to them. A dinner from 6–10 PM only offers Evening.
function partsFor(event) {
    const [from, to] = allowedMinutes(event);
    return dayParts
        .map(([name, start, end]) => ({ name, start: Math.max(start, from), end: Math.min(end, to) }))
        .filter((p) => p.start < p.end);
}

// Days down the side, parts of the day across. Tap a square, or a day or part of the day to fill
// the whole row or column.
function availabilitySection() {
    const event = state.event;
    const preferred = event.preferred_weekdays ?? [];
    const parts = partsFor(event);
    const today = startOfDay(new Date());
    const days = eachDay(event.search_start, event.search_end).filter((day) => day >= today);

    // A saved time turns on every part of the day it covers.
    const chosen = days.map((day) => parts.map((part) => state.windows.some((w) => {
        const start = new Date(w.start_time), end = new Date(w.end_time);
        return sameDay(start, day) && start <= atMinute(day, part.start) && end >= atMinute(day, part.end);
    })));

    const squares = [];
    const sync = () => squares.forEach(({ button, d, p }) => button.setAttribute("aria-pressed", String(chosen[d][p])));
    const toggleAll = (cells) => {
        const fill = !cells.every(([d, p]) => chosen[d][p]);
        cells.forEach(([d, p]) => { chosen[d][p] = fill; });
        sync();
    };

    const header = el("div", { class: "grid-row grid-header" }, el("span", { class: "grid-day" }),
        ...parts.map((part, p) => {
            const button = el("button", { type: "button", class: "grid-part", "aria-label": `Every ${part.name}` },
                el("strong", {}, part.name), el("span", {}, spanText(part)));
            button.addEventListener("click", () => toggleAll(days.map((_, d) => [d, p])));
            return button;
        }));

    const rows = days.map((day, d) => {
        const label = el("button", { type: "button", class: "grid-day", "aria-label": `All of ${dayText(day)}` },
            el("strong", {}, day.toLocaleDateString(undefined, { weekday: "short" }), preferred.includes(day.getDay() + 1) ? el("span", { class: "dot", "aria-hidden": "true" }) : null),
            el("span", {}, day.toLocaleDateString(undefined, { month: "short", day: "numeric" })));
        label.addEventListener("click", () => toggleAll(parts.map((_, p) => [d, p])));
        const cells = parts.map((part, p) => {
            const button = el("button", { type: "button", class: "grid-square", "aria-label": `${dayText(day)}, ${part.name}` });
            button.addEventListener("click", () => { chosen[d][p] = !chosen[d][p]; sync(); });
            squares.push({ button, d, p });
            return button;
        });
        return el("div", { class: "grid-row" }, label, ...cells);
    });
    sync();

    const problem = el("p", { class: "footnote error", hidden: true });
    const button = el("button", { class: "primary" }, state.windows.length ? "Update My Times" : "Save My Times");
    button.addEventListener("click", () => saveAvailability(days, parts, chosen, problem, button));

    return [
        el("h2", {}, "When Are You Free?"),
        days.length
            ? el("div", { class: "card grid", style: `--columns:${parts.length}` }, header, ...rows)
            : el("div", { class: "banner" }, "All the dates for this event have passed."),
        el("p", { class: "footnote" }, "Tap the times you could make it. Tap a day or a time of day to fill the whole row or column. Nobody else sees your free times."),
        problem,
        days.length ? button : null,
    ];
}

// MARK: - Saving

async function saveAvailability(days, parts, chosen, problem, button) {
    const minimum = state.event.duration_minutes;
    // Each day's chosen parts, joined where they touch.
    const windows = [];
    days.forEach((day, d) => {
        let current = null;
        parts.forEach((part, p) => {
            if (!chosen[d][p]) return;
            if (current && current.end === part.start) current.end = part.end;
            else windows.push(current = { day, start: part.start, end: part.end });
        });
    });
    const tooShort = windows.find((w) => w.end - w.start < minimum);
    if (tooShort) {
        problem.textContent = `On ${dayText(tooShort.day)}, that’s shorter than the ${duration(minimum)} event. Pick more of the day.`;
        problem.hidden = false;
        return;
    }
    problem.hidden = true;
    button.disabled = true;
    button.textContent = "Saving…";

    try {
        const pid = state.participantID;
        let result = await supabase.from("availability_windows").delete().eq("participant_id", pid);
        if (result.error) throw result.error;
        if (windows.length) {
            result = await supabase.from("availability_windows").insert(windows.map((w) => ({
                event_id: state.event.id,
                participant_id: pid,
                start_time: atMinute(w.day, w.start).toISOString(),
                end_time: atMinute(w.day, w.end).toISOString(),
                source: "manual",
                availability_type: "available",
            })));
            if (result.error) throw result.error;
        }
        result = await supabase.from("event_participants")
            .update({ availability_status: windows.length ? "submitted" : "not_submitted" })
            .eq("id", pid);
        if (result.error) throw result.error;

        await recalculate();
        await load();
        state.notice = windows.length
            ? "Thanks! You’re all set. Come back to this link anytime to see the time or change your answer."
            : "Saved. You haven’t picked any times yet.";
        showMain();
        window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
        problem.textContent = friendly(error);
        problem.hidden = false;
        button.disabled = false;
        button.textContent = "Try Again";
    }
}

// Lets the scheduling engine update the recommendation. Failing here isn't worth bothering the guest.
async function recalculate() {
    await supabase.functions.invoke("schedule-event", { body: { event_id: state.event.id } }).catch(() => {});
}

// MARK: - Helpers

// `minutes` after midnight on `day`, in this browser's time zone.
function atMinute(day, minutes) {
    const date = new Date(day);
    date.setHours(0, minutes, 0, 0);
    return date;
}

// Such as "5–10 PM".
function spanText(part) {
    const start = atMinute(new Date(2000, 0, 1), part.start), end = atMinute(new Date(2000, 0, 1), part.end);
    return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).formatRange(start, end);
}

function render(...children) {
    app.replaceChildren(...children.filter((c) => c !== null && c !== undefined));
}

// Builds an element. Text is always inserted as text, never as HTML.
function el(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (value === false || value === null || value === undefined) continue;
        if (value === true) node.setAttribute(key, "");
        else node.setAttribute(key, value);
    }
    node.append(...children.filter((c) => c !== null && c !== undefined));
    return node;
}

function row(label, value) {
    return el("div", { class: "row" }, el("span", { class: "label" }, label), el("span", { class: "value" }, value));
}

function friendly(error) {
    const message = error?.message || "";
    if (message.includes("already been accepted")) return "Someone else has already used this link. Ask the organizer for your own.";
    if (message.includes("invalid") || message.includes("revoked")) return "This invitation isn’t valid anymore.";
    if (message.toLowerCase().includes("anonymous")) return "Guest responses are turned off right now. Please let the organizer know.";
    return "Something went wrong. Check your connection and try again.";
}

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const slotFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function dayText(day) { return dayFormat.format(day); }
function slotText(c) { return `${slotFormat.format(new Date(c.start_time))} – ${timeFormat.format(new Date(c.end_time))}`; }

function dateRange(start, end) {
    const last = new Date(new Date(end).getTime() - 1);
    const format = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    return format.formatRange(new Date(start), last);
}

function duration(minutes) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest} min`;
    return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function eachDay(start, end) {
    const days = [];
    const last = new Date(end);
    for (let day = startOfDay(new Date(start)); day < last; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
        days.push(day);
    }
    return days;
}

function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}



