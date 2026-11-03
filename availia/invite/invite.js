// The page friends open from their invitation link. They can share availability and, if the group
// needs to decide, vote, all without the app or an account.
//
// How it works: the link carries a secret token. The guest signs in anonymously, then
// claim_invitation links that anonymous session to their spot in the event. From then on the
// database's privacy rules treat them like any participant: they can see the event and their own
// availability and votes, never anyone else's.
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
    votes: new Map(),   // candidate id → "yes" | "no" | "tentative"
    notice: null,       // a message shown after saving
    items: [],          // the Bring list
    updates: [],        // messages from the host
    names: new Map(),   // participant id → name, for the Bring list
};

// Cover colors, matching the app. Only these known values are ever used in styles.
const palettes = {
    blue: ["#3d8fff", "#1f52db"], orange: ["#ffa845", "#f2612e"], pink: ["#ff8cb8", "#e04585"],
    purple: ["#a87aff", "#6b40db"], green: ["#5cd17a", "#21945c"], teal: ["#47d1db", "#1a85a8"],
    red: ["#ff6b66", "#d1293d"], gray: ["#8c94a3", "#4d5261"],
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
    const [event, windows, candidates, votes, items, updates, people] = await Promise.all([
        supabase.from("events").select("*").eq("id", eventID).single(),
        supabase.from("availability_windows").select("start_time, end_time, availability_type")
            .eq("participant_id", state.participantID),
        supabase.from("candidate_slots").select("*").eq("event_id", eventID).in("status", ["active", "finalized"])
            .order("is_recommended", { ascending: false }).order("ranking_score", { ascending: false }),
        supabase.from("candidate_votes").select("candidate_id, vote").eq("participant_id", state.participantID),
        supabase.from("event_items").select("id, title, claimed_by").eq("event_id", eventID).order("created_at"),
        supabase.from("event_updates").select("id, body, created_at").eq("event_id", eventID).order("created_at", { ascending: false }),
        supabase.from("event_participants").select("id, display_name, participation_status").eq("event_id", eventID),
    ]);
    for (const result of [event, windows, candidates, votes]) if (result.error) throw result.error;
    // The Bring list and updates are extras; leave them empty rather than failing.
    state.items = items.data ?? [];
    state.updates = updates.data ?? [];
    state.names = new Map((people.data ?? []).map((p) => [p.id, p.display_name || "Guest"]));
    state.participation = (people.data ?? []).find((p) => p.id === state.participantID)?.participation_status;

    state.event = event.data;
    state.windows = windows.data.filter((w) => w.availability_type === "available");
    state.candidates = candidates.data;
    state.votes = new Map(votes.data.map((v) => [v.candidate_id, v.vote]));
}

// MARK: - Screens

function showProblem(message) {
    render(el("h1", {}, "Hmm."), el("p", { class: "lead" }, message));
}

function showWelcome() {
    const inv = state.invitation;
    const name = el("input", { type: "text", placeholder: "Your name", autocomplete: "given-name", maxlength: "60" });
    const button = el("button", { class: "primary", disabled: true }, "Continue");
    const problem = el("p", { class: "footnote error", hidden: true });

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
            await claim(name.value.trim());
            showMain();
        } catch (error) {
            problem.textContent = friendly(error);
            problem.hidden = false;
            button.disabled = false;
            button.textContent = "Continue";
        }
    });

    render(
        coverView(inv),
        el("h1", {}, inv.title),
        el("p", { class: "lead" }, `${inv.organizer_name || "A friend"} invited you and wants to find a time that works for everyone.`),
        detailsCard(inv),
        el("h2", {}, "Your Name"),
        el("div", { class: "card" }, el("div", { class: "row" }, name)),
        el("p", { class: "footnote" }, "So the organizer knows who responded. You don’t need an account or the app."),
        problem,
        button,
    );
    name.focus();
}

function showMain() {
    const event = state.event;
    const parts = [coverView(event), el("h1", {}, event.title), detailsCard(event)];

    if (state.notice) parts.push(el("div", { class: "banner success" }, state.notice));
    if (state.updates.length) parts.push(...updatesSection());

    if (event.status === "cancelled") {
        parts.push(el("div", { class: "banner" }, "This event was cancelled."));
    } else if (event.status === "confirmed") {
        parts.push(...confirmedSection());
    } else {
        const recommended = state.candidates.find((c) => c.is_recommended && c.status === "active");
        if (event.status === "awaiting_group_decision") parts.push(...pollSection());
        else if (recommended) parts.push(...recommendationSection(recommended));
        parts.push(...availabilitySection());
    }
    if (state.items.length && event.status !== "cancelled") parts.push(...bringSection());
    render(...parts);
}

// The invitation's cover: an emoji on the host's chosen colors.
function coverView(event) {
    const [from, to] = palettes[event.cover_palette] ?? palettes.blue;
    const cover = el("div", { class: "cover", "aria-hidden": "true" }, event.cover_emoji || "📅");
    cover.style.background = `linear-gradient(135deg, ${from}, ${to})`;
    return cover;
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

function recommendationSection(candidate) {
    return [
        el("h2", {}, "Best Time So Far"),
        el("div", { class: "card" }, el("div", { class: "row stacked" },
            el("strong", {}, slotText(candidate)),
            el("span", { class: "muted" }, candidate.selection_reason || ""),
        )),
        el("p", { class: "footnote" }, "The organizer will confirm the final time."),
    ];
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

// Going, not sure, or can't go. "Can't go" lets the host know.
function rsvpSection() {
    const current = state.participation ?? "undecided";
    const choices = [["attending", "I’m In"], ["undecided", "Not Sure"], ["not_attending", "Can’t Go"]];
    const buttons = choices.map(([value, label]) => {
        const button = el("button", { type: "button", "aria-pressed": String(current === value) }, label);
        button.addEventListener("click", () => rsvp(value));
        return button;
    });
    return [
        el("h2", {}, "Are You Going?"),
        el("div", { class: "card" }, el("div", { class: "row" }, el("div", { class: "choices", role: "group", "aria-label": "Are you going?" }, ...buttons))),
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

function pollSection() {
    const active = state.candidates.filter((c) => c.status === "active");
    const tied = active.filter((c) => c.is_tied);
    const options = tied.length ? tied : active;
    const choices = [["yes", "Yes"], ["tentative", "Maybe"], ["no", "No"]];

    const rows = options.map((candidate) => {
        const buttons = choices.map(([value, label]) => {
            const button = el("button", { type: "button", "aria-pressed": String(state.votes.get(candidate.id) === value) }, label);
            button.addEventListener("click", () => vote(candidate, value));
            return button;
        });
        const totals = `${candidate.yes_votes} yes · ${candidate.tentative_votes} maybe · ${candidate.no_votes} no`;
        return el("div", { class: "row stacked" },
            el("strong", {}, slotText(candidate)),
            el("span", { class: "muted" }, totals),
            el("div", { class: "choices", role: "group", "aria-label": `Vote for ${slotText(candidate)}` }, ...buttons),
        );
    });

    return [
        el("h2", {}, "Help Pick a Time"),
        el("div", { class: "card" }, ...rows),
        el("p", { class: "footnote" }, state.event.poll_deadline && new Date(state.event.poll_deadline) > new Date()
            ? `These times work equally well, so the group is voting until ${new Date(state.event.poll_deadline).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}. Only the host sees who voted for what.`
            : "These times work equally well, so the group is voting. Only the host sees who voted for what."),
    ];
}

function availabilitySection() {
    const event = state.event;
    const preferred = event.preferred_weekdays ?? [];
    const range = event.preferred_time_ranges?.[0] ?? { start_minute: 18 * 60, end_minute: 22 * 60 };
    const today = startOfDay(new Date());

    const days = eachDay(event.search_start, event.search_end).filter((day) => day >= today);
    const rows = days.map((day) => {
        const saved = state.windows.find((w) => sameDay(new Date(w.start_time), day));
        const on = el("input", { type: "checkbox", "aria-label": `Free on ${dayText(day)}` });
        const from = el("input", { type: "time", value: saved ? clock(new Date(saved.start_time)) : minutesToClock(range.start_minute) });
        const until = el("input", { type: "time", value: saved ? clock(new Date(saved.end_time)) : minutesToClock(range.end_minute) });
        on.checked = Boolean(saved);

        const times = el("div", { class: "times" }, from, "to", until);
        const label = el("span", { class: "label" }, dayText(day));
        if (preferred.includes(day.getDay() + 1)) label.append(el("span", { class: "tag" }, "Preferred"));
        const line = el("div", { class: "row" + (on.checked ? "" : " disabled") }, on, label, times);
        const sync = () => {
            line.classList.toggle("disabled", !on.checked);
            from.disabled = until.disabled = !on.checked;
        };
        on.addEventListener("change", sync);
        sync();
        return { day, on, from, until, line };
    });

    const problem = el("p", { class: "footnote error", hidden: true });
    const button = el("button", { class: "primary" }, state.windows.length ? "Update My Availability" : "Share My Availability");
    button.addEventListener("click", () => saveAvailability(rows, problem, button));

    return [
        el("h2", {}, "When Are You Free?"),
        rows.length
            ? el("div", { class: "card" }, ...rows.map((r) => r.line))
            : el("div", { class: "banner" }, "All the dates for this event have passed."),
        el("p", { class: "footnote" }, `Check each day you could make it and set the hours. Times are in your time zone. The event lasts ${duration(event.duration_minutes)}. Nobody else sees your free times; Availia only shares the times that work best.`),
        problem,
        rows.length ? button : el("span"),
    ];
}

// MARK: - Saving

async function saveAvailability(rows, problem, button) {
    const minimum = state.event.duration_minutes;
    const windows = [];
    for (const r of rows.filter((r) => r.on.checked)) {
        const start = atClock(r.day, r.from.value);
        const end = atClock(r.day, r.until.value);
        if (!start || !end || end - start < minimum * 60_000) {
            problem.textContent = `On ${dayText(r.day)}, the time you’re free needs to be at least ${duration(minimum)}.`;
            problem.hidden = false;
            return;
        }
        windows.push({ start, end });
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
                start_time: w.start.toISOString(),
                end_time: w.end.toISOString(),
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
            ? "Thanks! Your availability is saved. Come back to this link anytime to see the time or change your answer."
            : "Saved. You haven’t picked any days yet.";
        showMain();
        window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
        problem.textContent = friendly(error);
        problem.hidden = false;
        button.disabled = false;
        button.textContent = "Try Again";
    }
}

async function vote(candidate, value) {
    const pid = state.participantID;
    const row = { event_id: state.event.id, candidate_id: candidate.id, participant_id: pid, vote: value };
    let { error } = await supabase.from("candidate_votes").insert(row);
    if (error?.code === "23505") {
        // Already voted on this time: change the vote instead.
        ({ error } = await supabase.from("candidate_votes").update({ vote: value })
            .eq("candidate_id", candidate.id).eq("participant_id", pid));
    }
    if (error) {
        state.notice = friendly(error);
    } else {
        await recalculate();
        state.notice = "Vote saved. You can change it until the poll closes.";
    }
    await load();
    showMain();
}

// Lets the scheduling engine update the recommendation. Failing here isn't worth bothering the guest.
async function recalculate() {
    await supabase.functions.invoke("schedule-event", { body: { event_id: state.event.id } }).catch(() => {});
}

// MARK: - Helpers

function render(...children) {
    app.replaceChildren(...children);
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

function clock(date) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function minutesToClock(minutes) {
    minutes = Math.min(minutes, 23 * 60 + 59); // A range ending at midnight shows as 11:59 PM.
    return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function atClock(day, value) {
    const [hours, minutes] = value.split(":").map(Number);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes);
}
