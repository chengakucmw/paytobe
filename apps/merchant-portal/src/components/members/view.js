const ROLES = Object.freeze(["viewer", "developer", "admin", "owner"]);

export function renderMembers({ members = [], invitations = [], canManage = false, busy = false }) {
  return `<section aria-labelledby="members-title">
    <div class="section-heading"><div><h2 id="members-title">Members</h2><p>Membership access is enforced by the server.</p></div></div>
    ${canManage ? inviteForm(busy) : '<p class="muted">Your server-issued role has read-only membership access.</p>'}
    <div class="table-scroll"><table><thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th>${canManage ? '<th scope="col">Actions</th>' : ""}</tr></thead>
      <tbody>${members.length ? members.map((member) => memberRow(member, canManage, busy)).join("") : `<tr><td colspan="${canManage ? 4 : 3}">No memberships returned.</td></tr>`}</tbody>
    </table></div>
    ${invitations.length ? `<section aria-labelledby="invitation-title"><h3 id="invitation-title">Pending invitations</h3><ul class="invitation-list">${invitations.map(invitationRow).join("")}</ul></section>` : ""}
  </section>`;
}

function inviteForm(busy) {
  return `<form id="invite-member-form" class="inline-form">
    <div><label for="invite-email">Email</label><input id="invite-email" name="email" type="email" required autocomplete="email"></div>
    <div><label for="invite-role">Role</label><select id="invite-role" name="role">${ROLES.map((role) => `<option value="${role}">${capitalize(role)}</option>`).join("")}</select></div>
    <button type="submit" ${busy ? "disabled" : ""}>Invite member</button>
  </form>`;
}

function memberRow(member, canManage, busy) {
  const safeId = escapeHtml(member.membership_id);
  return `<tr data-membership-id="${safeId}">
    <td>${escapeHtml(member.email_normalized || "Unavailable")}</td>
    <td>${canManage ? `<label class="sr-only" for="role-${safeId}">Role for ${escapeHtml(member.email_normalized)}</label><select id="role-${safeId}" data-member-role>${ROLES.map((role) => `<option value="${role}" ${role === member.role ? "selected" : ""}>${capitalize(role)}</option>`).join("")}</select>` : escapeHtml(capitalize(member.role))}</td>
    <td>${escapeHtml(capitalize(member.status))}</td>
    ${canManage ? `<td class="row-actions"><button type="button" class="secondary" data-change-role data-version="${Number(member.version)}" ${busy ? "disabled" : ""}>Save role</button><button type="button" class="danger" data-remove-member data-version="${Number(member.version)}" ${busy ? "disabled" : ""}>Remove</button></td>` : ""}
  </tr>`;
}

function invitationRow(invitation) {
  return `<li><strong>${escapeHtml(invitation.email_normalized)}</strong><span>${escapeHtml(capitalize(invitation.role))}</span><span>${escapeHtml(capitalize(invitation.status))}</span><span>Expires ${escapeHtml(formatTime(invitation.expires_at))}</span></li>`;
}

function formatTime(value) {
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }) : "Unavailable";
}

function capitalize(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "Unavailable";
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}
