// The page group invite links open. Groups are for people with the Eventos app, so this page shows
// which group it is and hands the link to the app, which does the joining.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
    "https://xkfbnlsjqjyamiikmxki.supabase.co",
    "sb_publishable_UVXvc5Tixtvu9VbKxSlnyg_4Y68-FXx",
);

const token = new URLSearchParams(location.search).get("t");
const app = document.getElementById("app");

start();

async function start() {
    if (!token) return show("Hmm.", "This link is incomplete. Ask for it again.");

    const { data, error } = await supabase.rpc("get_group_invitation", { p_token: token });
    if (error || !data?.length) {
        return show("Hmm.", "This group link isn’t valid anymore. It may have expired. Ask for a new one.");
    }

    const group = data[0];
    const people = group.member_count === 1 ? "1 member" : `${group.member_count} members`;
    const open = document.createElement("a");
    open.className = "primary button";
    open.href = `availia://group?t=${encodeURIComponent(token)}`;
    open.textContent = "Open in Eventos";

    show(
        group.name,
        `${group.owner_name || "A friend"} invited you to join this group on Eventos. ${people}.`,
        open,
        note("Groups let friends plan together in one tap. You’ll need the Eventos app on your iPhone to join."),
    );
}

function show(title, text, ...extra) {
    const h1 = document.createElement("h1");
    h1.textContent = title;
    const p = document.createElement("p");
    p.className = "lead";
    p.textContent = text;
    app.replaceChildren(h1, p, ...extra);
}

function note(text) {
    const p = document.createElement("p");
    p.className = "footnote";
    p.textContent = text;
    return p;
}
