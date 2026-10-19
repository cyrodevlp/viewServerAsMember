/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import { findStoreLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildMemberStore, GuildRoleStore, GuildStore, Menu, PermissionsBits, PermissionStore, SelectedGuildStore, UserStore } from "@webpack/common";

const ImpersonateStore = findStoreLazy("ImpersonateStore");
const VoiceStateStore = findStoreLazy("VoiceStateStore");
const viewed = new Map<string, string>();
const viewedUser = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const expiry = new Map<string, ReturnType<typeof setTimeout>>();
const originals: Record<string, (...a: any[]) => any> = {};
const VOICE = new Set([2, 13]);
const ALL = (1n << 64n) - 1n;
let observer: MutationObserver | null = null, raf = 0, selfDispatch = false;

const P = () => PermissionsBits as unknown as Record<string, bigint>;
const isViewing = (g: string) => { try { return !!ImpersonateStore?.getViewingRoles?.(g) || !!ImpersonateStore?.isFullServerPreview?.(g); } catch { return false; } };
const realCan = (p: bigint, c: any) => (originals.can ?? (PermissionStore as any).can).call(PermissionStore, p, c);
const refresh = () => { try { (PermissionStore as any).emitChange?.(); } catch { } };
const overwrite = (p: bigint, o: any) => o ? (p & ~BigInt(o.deny ?? 0)) | BigInt(o.allow ?? 0) : p;
const timedOut = (m: any) => new Date(m?.communicationDisabledUntil ?? 0).getTime() > Date.now();
const inVoice = (g: string, u: string, c: string) => { try { const v = VoiceStateStore.getVoiceStateForUser?.(u); return !!v && v.channelId === c && (!v.guildId || v.guildId === g); } catch { return false; } };

const canUse = (g: string) => {
    try {
        const guild = GuildStore.getGuild(g);
        if (!guild) return false;
        if (guild.ownerId === UserStore.getCurrentUser().id || realCan(PermissionsBits.ADMINISTRATOR, guild)) return true;
        const channels = Object.values((ChannelStore as any).getMutableGuildChannelsForGuild(g) ?? {}) as any[];
        return channels.length > 0 && channels.every(c => realCan(PermissionsBits.VIEW_CHANNEL, c));
    } catch { return false; }
};

function compute(gid: string, uid: string, ch?: any): bigint | null {
    const guild = GuildStore.getGuild(gid);
    if (!guild) return null;
    if (guild.ownerId === uid) return ALL;
    const member: any = GuildMemberStore.getMember(gid, uid);
    if (!member) return null;
    const roles: string[] = member.roles ?? [];
    let p = [gid, ...roles].reduce((a, id) => a | BigInt(GuildRoleStore.getRole(gid, id)?.permissions ?? 0), 0n);
    if (p & P().ADMINISTRATOR) return ALL;
    if (ch) {
        const thread = !!ch.isThread?.();
        const o: Record<string, any> = (thread && ch.parent_id ? ChannelStore.getChannel(ch.parent_id) ?? ch : ch).permissionOverwrites ?? {};
        let allow = 0n, deny = 0n;
        for (const id of roles) { allow |= BigInt(o[id]?.allow ?? 0); deny |= BigInt(o[id]?.deny ?? 0); }
        p = overwrite((overwrite(p, o[gid]) & ~deny) | allow, o[uid]);
        if (VOICE.has(ch.type) && inVoice(gid, uid, ch.id)) p |= P().VIEW_CHANNEL | P().CONNECT;
        if (thread) p = (p & P().SEND_MESSAGES_IN_THREADS) ? p | P().SEND_MESSAGES : p & ~P().SEND_MESSAGES;
        if (!(p & P().SEND_MESSAGES)) p &= ~(P().SEND_TTS_MESSAGES | P().MENTION_EVERYONE | P().EMBED_LINKS | P().ATTACH_FILES);
        if (!(p & P().VIEW_CHANNEL)) p = 0n;
    }
    return timedOut(member) ? p & (P().VIEW_CHANNEL | P().READ_MESSAGE_HISTORY) : p;
}

function forContext(c: any): bigint | null {
    try {
        if (!c || typeof c !== "object") return null;
        const isCh = !!c.guild_id && c.permissionOverwrites !== undefined;
        const gid: string | null = isCh ? c.guild_id : !c.guild_id && c.ownerId && GuildStore.getGuild(c.id) ? c.id : null;
        if (!gid) return null;
        const uid = viewedUser.get(gid);
        return uid && isViewing(gid) ? compute(gid, uid, isCh ? c : undefined) : null;
    } catch { return null; }
}

const PATCHED: Record<string, boolean> = { can: true, canBasicChannel: true, getChannelPermissions: false, getGuildPermissions: false };

const wrap = (check: boolean, orig: (...a: any[]) => any) => function (this: any, ...args: any[]) {
    if (check ? args.length === 2 : args.length === 1) {
        const p = forContext(args[check ? 1 : 0]);
        if (p !== null) return check ? (p & BigInt(args[0])) === BigInt(args[0]) : p;
    }
    return orig.apply(this, args);
};

function pushImpersonation(g: string) {
    const uid = viewedUser.get(g);
    const m = uid ? GuildMemberStore.getMember(g, uid) : null;
    if (!m) return false;
    const roles = Object.fromEntries((m.roles ?? []).map(id => [id, GuildRoleStore.getRole(g, id)]).filter(([, r]) => r));
    selfDispatch = true;
    try { FluxDispatcher.dispatch({ type: "IMPERSONATE_UPDATE", guildId: g, data: { type: "ROLES", roles } }); } finally { selfDispatch = false; }
    refresh();

    clearTimeout(expiry.get(g));
    const until = new Date((m as any).communicationDisabledUntil ?? 0).getTime();
    if (until > Date.now()) expiry.set(g, setTimeout(() => scheduleResync(g), Math.min(until - Date.now() + 500, 2147483647)));
    return true;
}

function scheduleResync(g: string) {
    if (!viewedUser.has(g)) return;
    clearTimeout(timers.get(g));
    timers.set(g, setTimeout(() => {
        timers.delete(g);
        if (!viewedUser.has(g) || !isViewing(g)) return;
        if (!pushImpersonation(g)) stopViewing(g);
        schedule();
    }, 50));
}

const stopViewing = (guildId: string) => { setTimeout(() => FluxDispatcher.dispatch({ type: "IMPERSONATE_STOP", guildId }), 0); };
const resync = (g?: string) => g && viewedUser.has(g) && scheduleResync(g);

function clearGuild(g: string) {
    viewed.delete(g);
    viewedUser.delete(g);
    clearTimeout(timers.get(g));
    clearTimeout(expiry.get(g));
    timers.delete(g);
    expiry.delete(g);
}

function viewAs(guildId: string, userId: string) {
    if (!GuildMemberStore.getMember(guildId, userId)) return;
    const user: any = UserStore.getUser(userId);
    viewed.set(guildId, GuildMemberStore.getNick(guildId, userId) ?? user?.globalName ?? user?.username ?? "Unknown");
    viewedUser.set(guildId, userId);
    pushImpersonation(guildId);
    schedule();
}

function onUpdate({ guildId, data }: { guildId: string; data?: any; }) {
    const uid = viewedUser.get(guildId);
    if (selfDispatch || !uid) return;
    if (data?.type === "ROLES" && data.roles) {
        const ids: string[] = Array.isArray(data.roles) ? data.roles.map((r: any) => r?.id ?? r) : Object.keys(data.roles);
        const norm = (l: string[]) => new Set(l.filter(id => id !== guildId));
        const a = norm(ids), b = norm(GuildMemberStore.getMember(guildId, uid)?.roles ?? []);
        if (a.size === b.size && [...a].every(id => b.has(id))) return;
    }
    clearGuild(guildId);
}

const roleEvents = ["GUILD_UPDATE", "GUILD_ROLE_CREATE", "GUILD_ROLE_UPDATE", "GUILD_ROLE_DELETE"];
const channelEvents = ["CHANNEL_CREATE", "CHANNEL_UPDATES", "CHANNEL_DELETE"];
const subscriptions: [string, (e: any) => void][] = [
    ["IMPERSONATE_STOP", ({ guildId }) => { clearGuild(guildId); refresh(); }],
    ["IMPERSONATE_UPDATE", onUpdate],
    ["VOICE_STATE_UPDATES", ({ voiceStates }) => voiceStates?.forEach((v: any) => viewedUser.get(v.guildId) === v.userId && resync(v.guildId))],
    ["GUILD_MEMBER_UPDATE", ({ guildId, user }) => viewedUser.get(guildId) === user?.id && resync(guildId)],
    ["GUILD_MEMBER_REMOVE", ({ guildId, user }) => viewedUser.get(guildId) === user?.id && stopViewing(guildId)],
    ...roleEvents.map(t => [t, (e: any) => resync(e.guildId ?? e.guild?.id)] as [string, (e: any) => void]),
    ...channelEvents.map(t => [t, (e: any) => (e.channels ?? [e.channel]).forEach((c: any) => resync(c?.guild_id))] as [string, (e: any) => void])
];

function fixBanner() {
    raf = 0;
    const guildId = SelectedGuildStore.getGuildId();
    const name = guildId ? viewed.get(guildId) : undefined;
    if (!guildId || !name || !isViewing(guildId)) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n: Node | null; (n = walker.nextNode());) {
        if (!/^\s*You are viewing this server as\b/i.test(n.nodeValue ?? "")) continue;
        const prefix = "You are viewing this server as ";
        const next = n.nextSibling as HTMLElement | null;
        const old = next?.dataset?.vcName;
        if (n.nodeValue === prefix && old === name) break;
        if (old !== undefined) next!.remove();
        n.nodeValue = prefix;
        const span = Object.assign(document.createElement("span"), { innerHTML: "<strong style=\"font-weight:700\"></strong>." });
        span.dataset.vcName = name;
        span.firstElementChild!.textContent = name;
        (n as Text).after(span);
        break;
    }
    document.querySelectorAll<HTMLElement>("button, [role=\"button\"]").forEach(el => {
        if (/^(Back to Roles Settings|Select Roles)$/.test(el.textContent?.trim() ?? "")) el.style.display = "none";
    });
}

const schedule = () => { raf ||= requestAnimationFrame(fixBanner); };

const userContextPatch: NavContextMenuPatchCallback = (children, props: any) => {
    const guildId = props?.guildId ?? props?.channel?.guild_id;
    const user = props?.user;
    if (!guildId || !user || !canUse(guildId)) return;
    (findGroupChildrenByChildId("roles", children) ?? children).push(
        <Menu.MenuItem
            key="vc-view-server-as-member"
            id="vc-view-server-as-member"
            label="View Server As Member"
            action={() => viewAs(guildId, user.id)}
        />
    );
};

export default definePlugin({
    name: "ViewServerAsMember",
    description: "Preview the server as a member (Only for Server Administrators and Server Owners).",
    authors: [{ name: "cyrodev", id: 921065758526681088n }],
    contextMenus: { "user-context": userContextPatch },
    start() {
        for (const [name, kind] of Object.entries(PATCHED)) {
            const orig = (PermissionStore as any)[name];
            if (typeof orig !== "function" || originals[name]) continue;
            originals[name] = orig;
            (PermissionStore as any)[name] = wrap(kind, orig);
        }
        subscriptions.forEach(([t, cb]) => FluxDispatcher.subscribe(t, cb));
        observer = new MutationObserver(() => viewed.size && schedule());
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    },
    stop() {
        subscriptions.forEach(([t, cb]) => FluxDispatcher.unsubscribe(t, cb));
        observer?.disconnect();
        observer = null;
        cancelAnimationFrame(raf);
        raf = 0;
        timers.forEach(clearTimeout);
        expiry.forEach(clearTimeout);
        timers.clear();
        expiry.clear();
        const guildId = SelectedGuildStore.getGuildId();
        if (guildId && isViewing(guildId)) FluxDispatcher.dispatch({ type: "IMPERSONATE_STOP", guildId });
        viewed.clear();
        viewedUser.clear();
        for (const name of Object.keys(originals)) { (PermissionStore as any)[name] = originals[name]; delete originals[name]; }
        refresh();
        document.querySelectorAll("[data-vc-name]").forEach(e => e.remove());
    }
});