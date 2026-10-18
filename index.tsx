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
const viewed = new Map<string, string>();
let observer: MutationObserver | null = null;
let raf = 0;

const isViewing = (g: string) => {
    try { return !!ImpersonateStore?.getViewingRoles?.(g) || !!ImpersonateStore?.isFullServerPreview?.(g); } catch { return false; }
};

const canUse = (g: string) => {
    try {
        const guild = GuildStore.getGuild(g);
        if (!guild) return false;
        if (guild.ownerId === UserStore.getCurrentUser().id || PermissionStore.can(PermissionsBits.ADMINISTRATOR, guild)) return true;
        const channels = Object.values((ChannelStore as any).getMutableGuildChannelsForGuild(g) ?? {}) as any[];
        return channels.length > 0 && channels.every(c => PermissionStore.can(PermissionsBits.VIEW_CHANNEL, c));
    } catch { return false; }
};

function viewAs(guildId: string, userId: string) {
    const member = GuildMemberStore.getMember(guildId, userId);
    if (!member) return;
    const user: any = UserStore.getUser(userId);
    const roles = Object.fromEntries((member.roles ?? []).map(id => [id, GuildRoleStore.getRole(guildId, id)]).filter(([, r]) => r));
    viewed.set(guildId, GuildMemberStore.getNick(guildId, userId) ?? user?.globalName ?? user?.username ?? "Unknown");
    FluxDispatcher.dispatch({ type: "IMPERSONATE_UPDATE", guildId, data: { type: "ROLES", roles } });
    schedule();
}

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
const onStop = ({ guildId }: { guildId: string; }) => { viewed.delete(guildId); };
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
        FluxDispatcher.subscribe("IMPERSONATE_STOP", onStop);
        observer = new MutationObserver(() => viewed.size && schedule());
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    },
    stop() {
        FluxDispatcher.unsubscribe("IMPERSONATE_STOP", onStop);
        observer?.disconnect();
        observer = null;
        cancelAnimationFrame(raf);
        raf = 0;
        const guildId = SelectedGuildStore.getGuildId();
        if (guildId && isViewing(guildId)) FluxDispatcher.dispatch({ type: "IMPERSONATE_STOP", guildId });
        viewed.clear();
        document.querySelectorAll("[data-vc-name]").forEach(e => e.remove());
    }
});