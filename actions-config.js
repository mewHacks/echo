// actions-config.js
// Centralized action definitions for Discord moderation/admin tools
// Each action defines: description, parameters, permission, and implementation

const { PermissionFlagsBits } = require('discord.js');

// Helper function to check if user has permission (includes Administrator override)
const hasPermission = (userPermissions, requiredPermission) => {
  console.log(`[Permission Check] Checking ${requiredPermission}:`, {
    hasPermissions: !!userPermissions,
    permissionsList: userPermissions?.toArray?.() || 'N/A',
  });

  if (!userPermissions) {
    console.warn(`[Permission Check] No permissions object provided!`);
    return false;
  }

  // Administrator permission overrides all other checks
  if (userPermissions.has(PermissionFlagsBits.Administrator)) {
    console.log(`[Permission Check] User is Administrator - allow all actions`);
    console.log(`[Permission Check] User is Administrator - allow all actions`);
    return true;
  }

  // Check for the specific permission
  const hasSpecificPerm = userPermissions.has(PermissionFlagsBits[requiredPermission]);
  console.log(`[Permission Check] Has ${requiredPermission}:`, hasSpecificPerm);
  return hasSpecificPerm;
};

// Helper function to convert color names to hex codes
const colorNameToHex = (color) => {
  if (!color) return null;

  // If already hex format, return as-is
  if (/^#?[0-9A-Fa-f]{6}$/.test(color)) {
    return color.startsWith('#') ? color : `#${color}`;
  }

  // Color name mappings
  const colorMap = {
    'red': '#FF0000',
    'dark red': '#8B0000',
    'light red': '#FF6B6B',
    'blue': '#0000FF',
    'dark blue': '#00008B',
    'light blue': '#ADD8E6',
    'sky blue': '#87CEEB',
    'green': '#00FF00',
    'dark green': '#006400',
    'light green': '#90EE90',
    'yellow': '#FFFF00',
    'gold': '#FFD700',
    'orange': '#FFA500',
    'dark orange': '#FF8C00',
    'purple': '#800080',
    'light purple': '#DDA0DD',
    'pink': '#FFC0CB',
    'hot pink': '#FF69B4',
    'magenta': '#FF00FF',
    'cyan': '#00FFFF',
    'teal': '#008080',
    'brown': '#A52A2A',
    'white': '#FFFFFF',
    'black': '#000000',
    'gray': '#808080',
    'grey': '#808080',
    'light gray': '#D3D3D3',
    'light grey': '#D3D3D3',
    'dark gray': '#A9A9A9',
    'dark grey': '#A9A9A9',
    'silver': '#C0C0C0',
    'navy': '#000080',
    'maroon': '#800000',
    'lime': '#00FF00',
    'aqua': '#00FFFF',
    'olive': '#808000',
    'fuchsia': '#FF00FF',
  };

  const normalized = color.toLowerCase().trim();
  return colorMap[normalized] || null;
};

// Helper to resolve a target member with robust fuzzy matching and ambiguity checks
const resolveTargetMember = async (guild, userIdInput, senderMember) => {
  const cleanId = userIdInput.replace(/[<@!>]/g, '');

  // Prevent self-targeting
  if (cleanId === senderMember.id) {
    throw new Error("You cannot target yourself. Self-targeting is not allowed for this action.");
  }

  let targetMember = null;

  // Try to fetch by ID first (if it looks like a valid snowflake)
  if (/^\d{17,19}$/.test(cleanId)) {
    try {
      targetMember = await guild.members.fetch(cleanId);
    } catch (err) {
      // Not found by ID, proceed to name search
    }
  }

  // If not found by ID, try fuzzy name matching using Discord API
  if (!targetMember) {
    const searchName = cleanId.toLowerCase();

    // Use Discord's native search API (more reliable than local cache)
    const searchResults = await guild.members.fetch({ query: cleanId, limit: 10 });

    // Find EXACT matches first from search results
    // Checks: username, tag (user#0000), nickname, or global display name
    let exactMatches = searchResults.filter(m =>
      m.user.username.toLowerCase() === searchName ||
      m.user.tag.toLowerCase() === searchName ||
      (m.nickname && m.nickname.toLowerCase() === searchName) ||
      (m.user.globalName && m.user.globalName.toLowerCase() === searchName)
    );

    if (exactMatches.size > 0) {
      if (exactMatches.size === 1) {
        // If found exactly one perfect match, select it
        targetMember = exactMatches.first();
      } else {
        // If found multiple perfect matches (Ambiguous) return error
        const matchList = exactMatches.map(m => `- ${m.user.tag} (ID: ${m.id})`).join('\n');
        throw new Error(`Multiple users match "${userIdInput}":\n${matchList}\n\nPlease use @mention or the exact user ID.`);
      }
    }

    // If no exact match found, API results are inherently PARTIAL matches
    if (!targetMember) {
      // If multiple results returned from API and none were exact, it's ambiguous
      if (searchResults.size > 1) {
        const matchList = searchResults.map(m => `- ${m.user.tag} (ID: ${m.id})`).join('\n');
        throw new Error(`Multiple users match "${userIdInput}":\n${matchList}\n\nPlease be more specific or use @mention.`);
      }

      // If only one result returned from API, select it
      if (searchResults.size === 1) {
        targetMember = searchResults.first();
      }
    }
  }

  // If still no target member found, throw error
  if (!targetMember) {
    throw new Error(`Could not find user "${userIdInput}". Please use @mention, user ID, or exact username.`);
  }

  // Prevent targeting the bot itself
  if (targetMember.id === guild.members.me.id) {
    throw new Error("Cannot target the bot itself.");
  }

  return targetMember;
};

const actionsConfig = {
  kick_member: {
    description: 'Kicks a member from the server.',
    permission: 'KickMembers',
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: { type: 'STRING', description: 'The ID, @mention, username, or nickname of the user to kick.' },
        reason: { type: 'STRING', description: 'The reason for the kick.' },
      },
      required: ['userId'],
    },
    // buildContext removed
    execute: async (args, context) => {
      const { userId, reason } = args;
      const { guild, member } = context;

      if (!hasPermission(member?.permissions, 'KickMembers')) {
        return "Error: The user invoking this command does not have the Kick Members permission.";
      }

      try {
        const targetMember = await resolveTargetMember(guild, userId, member);
        await targetMember.kick(reason || "No reason provided");
        return `Successfully kicked ${targetMember.user.tag}`;
      } catch (err) {
        return err.message.startsWith('Error:') ? err.message : `Error: ${err.message}`;
      }
    },
  },

  delete_messages: {
    description: 'Deletes a specific number of messages from the channel.',
    permission: 'ManageMessages',
    parameters: {
      type: 'OBJECT',
      properties: {
        amount: { type: 'NUMBER', description: 'Number of messages to delete (1-100).' },
      },
      required: ['amount'],
    },
    execute: async (args, context) => {
      const { amount } = args;
      const { channel, member } = context;

      console.log(`[delete_messages] Called with amount=${amount}, member=${member?.user?.tag || 'unknown'}`);

      if (!hasPermission(member?.permissions, 'ManageMessages')) {
        console.log(`[delete_messages] Permission denied for ${member?.user?.tag || 'unknown'}`);
        return "Error: The user invoking this command does not have the Manage Messages permission.";
      }

      const numToDelete = Math.min(Math.max(parseInt(amount) || 1, 1), 100);
      const deleted = await channel.bulkDelete(numToDelete, true);
      return `Successfully deleted ${deleted.size} message(s).`;
    },
  },

  ban_member: {
    description: 'Bans a member from the server.',
    permission: 'BanMembers',
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: { type: 'STRING', description: 'The ID, @mention, username, or nickname of the user to ban.' },
        reason: { type: 'STRING', description: 'The reason for the ban.' },
        deleteMessageDays: { type: 'NUMBER', description: 'Number of days of messages to delete (0-7).' },
      },
      required: ['userId'],
    },
    // buildContext removed
    execute: async (args, context) => {
      const { userId, reason, deleteMessageDays } = args;
      const { guild, member } = context;

      if (!hasPermission(member?.permissions, 'BanMembers')) {
        return "Error: The user invoking this command does not have the Ban Members permission.";
      }

      try {
        // Try to resolve as member first (for consistent name search)
        let targetId = userId.replace(/[<@!>]/g, '');
        let targetName = targetId;

        try {
          const targetMember = await resolveTargetMember(guild, userId, member);
          targetId = targetMember.id;
          targetName = targetMember.user.tag;
        } catch (resolveErr) {
          // If search fails BUT it looks like a valid ID, allow banning by ID (user might not be in server)
          if (!/^\d{17,19}$/.test(targetId)) {
            throw resolveErr; // Re-throw if it's not a valid ID
          }
          // It's a valid ID, so we proceed with the raw ID for the ban
        }

        await guild.members.ban(targetId, {
          reason: reason || "No reason provided",
          deleteMessageSeconds: Math.min(Math.max(deleteMessageDays || 0, 0), 7) * 86400
        });
        return `Successfully banned ${targetName}. Reason: ${reason || 'No reason provided'}`;
      } catch (err) {
        return err.message.startsWith('Error:') ? err.message : `Error: ${err.message}`;
      }
    },
  },

  unban_member: {
    description: 'Unbans a user from the server.',
    permission: 'BanMembers',
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: { type: 'STRING', description: 'The ID of the user to unban.' },
        reason: { type: 'STRING', description: 'The reason for the unban.' },
      },
      required: ['userId'],
    },
    // buildContext removed
    execute: async (args, context) => {
      const { userId, reason } = args;
      const { guild, member } = context;
      if (!hasPermission(member?.permissions, 'BanMembers')) {
        return "Error: The user invoking this command does not have the Ban Members permission.";
      }
      const cleanId = userId.replace(/[<@!>]/g, '');

      // Unban relies on IDs usually, but let's just proceed with cleanId
      try {
        await guild.members.unban(cleanId, reason || "No reason provided");
        return `Successfully unbanned user ${cleanId}`;
      } catch (err) {
        return `Error: Could not unban user. ${err.message}`;
      }
    },
  },

  timeout_member: {
    description: 'Times out a member (prevents them from sending messages, joining voice, etc.).',
    permission: 'ModerateMembers',
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: { type: 'STRING', description: 'The ID, @mention, username, or nickname of the user to timeout.' },
        duration: { type: 'NUMBER', description: 'Duration in minutes (max 40320 = 28 days).' },
        reason: { type: 'STRING', description: 'The reason for the timeout.' },
      },
      required: ['userId', 'duration'],
    },
    // buildContext removed
    execute: async (args, context) => {
      const { userId, duration, reason } = args;
      const { guild, member } = context;
      if (!hasPermission(member?.permissions, 'ModerateMembers')) {
        return "Error: The user invoking this command does not have the Moderate Members permission.";
      }

      try {
        const targetMember = await resolveTargetMember(guild, userId, member);

        // Check if target is admin (cannot timeout admins)
        if (targetMember.permissions.has(PermissionFlagsBits.Administrator)) {
          return "Error: Cannot timeout an Administrator.";
        }
        // Check hierarchy
        if (!targetMember.manageable) {
          return "Error: I cannot timeout this user due to role hierarchy.";
        }

        const timeoutMs = Math.min(duration * 60 * 1000, 40320 * 60 * 1000);
        await targetMember.timeout(timeoutMs, reason || "No reason provided");
        return `Successfully timed out ${targetMember.user.tag} for ${duration} minutes`;

      } catch (err) {
        return err.message.startsWith('Error:') ? err.message : `Error: ${err.message}`;
      }
    },
  },

  remove_timeout: {
    description: 'Removes timeout from a member.',
    permission: 'ModerateMembers',
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: { type: 'STRING', description: 'The ID, @mention, username, or nickname of the user.' },
        reason: { type: 'STRING', description: 'The reason for removing timeout.' },
      },
      required: ['userId'],
    },
    // buildContext removed
    execute: async (args, context) => {
      const { userId, reason } = args;
      const { guild, member } = context;
      if (!hasPermission(member?.permissions, 'ModerateMembers')) {
        return "Error: The user invoking this command does not have the Moderate Members permission.";
      }

      try {
        const targetMember = await resolveTargetMember(guild, userId, member);
        await targetMember.timeout(null, reason || "Timeout removed");
        return `Successfully removed timeout from ${targetMember.user.tag}`;
      } catch (err) {
        return err.message.startsWith('Error:') ? err.message : `Error: ${err.message}`;
      }
    },
  },

  // === ROLE MANAGEMENT ACTIONS ===

  create_role: {
    description: 'Creates a new role in the server with specified properties.',
    permission: 'ManageRoles',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'The name of the role.' },
        color: { type: 'STRING', description: 'The color of the role (hex like #FF0000 or color name).' },
        hoist: { type: 'BOOLEAN', description: 'Whether to display role members separately in the member list.' },
        mentionable: { type: 'BOOLEAN', description: 'Whether the role can be mentioned.' },
        reason: { type: 'STRING', description: 'The reason for creating the role.' },
      },
      required: ['name'],
    },
    // buildContext removed
    execute: async (args, context) => {
      const { name, color, hoist, mentionable, reason } = args;
      const { guild, member } = context;
      if (!hasPermission(member?.permissions, 'ManageRoles')) {
        return "Error: The user invoking this command does not have the Manage Roles permission.";
      }

      // Convert color name to hex
      const hexColor = color ? colorNameToHex(color) : null;
      if (color && !hexColor) {
        return `Error: Invalid color "${color}". Use hex format (#FF0000) or common color names (red, blue, green, etc.).`;
      }

      const role = await guild.roles.create({
        name,
        color: hexColor || null,
        hoist: hoist || false,
        mentionable: mentionable || false,
        reason: reason || "No reason provided",
      });
      return `Successfully created role "${role.name}". Role ID is: ${role.id}. Use this ID to apply the role to members. Color: ${role.hexColor}, Hoisted: ${role.hoist}, Mentionable: ${role.mentionable}`;
    },
  },

  delete_role: {
    description: 'Deletes a role from the server.',
    permission: 'ManageRoles',
    parameters: {
      type: 'OBJECT',
      properties: {
        roleId: { type: 'STRING', description: 'The ID or name of the role to delete.' },
        reason: { type: 'STRING', description: 'The reason for deleting the role.' },
      },
      required: ['roleId'],
    },
    // buildContext removed
    execute: async (args, context) => {
      const { roleId, reason } = args;
      const { guild, member } = context;
      if (!hasPermission(member?.permissions, 'ManageRoles')) {
        return "Error: The user invoking this command does not have the Manage Roles permission.";
      }
      const cleanId = roleId.replace(/[<@&>]/g, '');
      let role = guild.roles.cache.get(cleanId);
      if (!role) {
        role = guild.roles.cache.find(r => r.name.toLowerCase() === roleId.toLowerCase());
      }
      if (!role) {
        return `Error: Role "${roleId}" not found.`;
      }
      const roleName = role.name;
      await role.delete(reason || "No reason provided");
      return `Successfully deleted role "${roleName}"`;
    },
  },

  edit_role: {
    description: 'Edits an existing role\'s properties (name, color, hoist, mentionable, etc.).',
    permission: 'ManageRoles',
    parameters: {
      type: 'OBJECT',
      properties: {
        roleId: { type: 'STRING', description: 'The ID or name of the role to edit.' },
        name: { type: 'STRING', description: 'New name for the role.' },
        color: { type: 'STRING', description: 'New color (hex like #FF0000 or color name).' },
        hoist: { type: 'BOOLEAN', description: 'Whether to display role members separately.' },
        mentionable: { type: 'BOOLEAN', description: 'Whether the role can be mentioned.' },
        reason: { type: 'STRING', description: 'The reason for editing the role.' },
      },
      required: ['roleId'],
    },
    // buildContext removed
    execute: async (args, context) => {
      const { roleId, name, color, hoist, mentionable, reason } = args;
      const { guild, member } = context;
      if (!hasPermission(member?.permissions, 'ManageRoles')) {
        return "Error: The user invoking this command does not have the Manage Roles permission.";
      }
      const cleanId = roleId.replace(/[<@&>]/g, '');
      let role = guild.roles.cache.get(cleanId);
      if (!role) {
        role = guild.roles.cache.find(r => r.name.toLowerCase() === roleId.toLowerCase());
      }
      if (!role) {
        return `Error: Role "${roleId}" not found.`;
      }
      const updates = {};
      if (name !== undefined) updates.name = name;
      if (color !== undefined) {
        const hexColor = colorNameToHex(color);
        if (!hexColor) {
          return `Error: Invalid color "${color}". Use hex format (#FF0000) or common color names (red, blue, green, etc.).`;
        }
        updates.color = hexColor;
      }
      if (hoist !== undefined) updates.hoist = hoist;
      if (mentionable !== undefined) updates.mentionable = mentionable;

      await role.edit(updates, reason || "No reason provided");
      return `Successfully edited role "${role.name}". Updates: ${JSON.stringify(updates)}`;
    },
  },

  add_role_to_member: {
    description: 'Adds a role to a member. Use the member\'s user ID. When the user says "me" or "myself", use the sender\'s ID.',
    permission: 'ManageRoles',
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: { type: 'STRING', description: 'The ID, @mention, username of the user.' },
        roleId: { type: 'STRING', description: 'The ID or name of the role to add.' },
        reason: { type: 'STRING', description: 'The reason for adding the role.' },
      },
      required: ['userId', 'roleId'],
    },
    // buildContext removed
    execute: async (args, context) => {
      const { userId, roleId, reason } = args;
      const { guild, member } = context;
      if (!hasPermission(member?.permissions, 'ManageRoles')) {
        return "Error: The user invoking this command does not have the Manage Roles permission.";
      }

      try {
        const targetMember = await resolveTargetMember(guild, userId, member);

        // Find the role
        const cleanRoleId = roleId.replace(/[<@&>]/g, '').trim();
        let role = guild.roles.cache.get(cleanRoleId);
        if (!role) {
          role = guild.roles.cache.find(r => r.name.toLowerCase() === roleId.toLowerCase());
        }
        if (!role) {
          return `Error: Role "${roleId}" not found.`;
        }

        await targetMember.roles.add(role, reason || "No reason provided");
        return `Successfully added role "${role.name}" to ${targetMember.user.tag}`;

      } catch (err) {
        return err.message.startsWith('Error:') ? err.message : `Error: ${err.message}`;
      }
    },
  },

  remove_role_from_member: {
    description: 'Removes a role from a member.',
    permission: 'ManageRoles',
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: { type: 'STRING', description: 'The ID, @mention, username of the user.' },
        roleId: { type: 'STRING', description: 'The ID or name of the role to remove.' },
        reason: { type: 'STRING', description: 'The reason for removing the role.' },
      },
      required: ['userId', 'roleId'],
    },
    // buildContext removed
    execute: async (args, context) => {
      const { userId, roleId, reason } = args;
      const { guild, member } = context;
      if (!hasPermission(member?.permissions, 'ManageRoles')) {
        return "Error: The user invoking this command does not have the Manage Roles permission.";
      }

      try {
        const targetMember = await resolveTargetMember(guild, userId, member);

        const cleanRoleId = roleId.replace(/[<@&>]/g, '');
        let role = guild.roles.cache.get(cleanRoleId);
        if (!role) {
          role = guild.roles.cache.find(r => r.name.toLowerCase() === roleId.toLowerCase());
        }
        if (!role) {
          return `Error: Role "${roleId}" not found.`;
        }

        await targetMember.roles.remove(role, reason || "No reason provided");
        return `Successfully removed role "${role.name}" from ${targetMember.user.tag}`;
      } catch (err) {
        return err.message.startsWith('Error:') ? err.message : `Error: ${err.message}`;
      }
    },
  },

  set_role_permissions: {
    description: 'Sets specific permissions for a role.',
    permission: 'ManageRoles',
    parameters: {
      type: 'OBJECT',
      properties: {
        roleId: { type: 'STRING', description: 'The ID or name of the role.' },
        permissions: {
          type: 'ARRAY',
          description: 'Array of permission names to grant (e.g., ["ManageMessages", "KickMembers"]).',
          items: { type: 'STRING' }
        },
        reason: { type: 'STRING', description: 'The reason for changing permissions.' },
      },
      required: ['roleId', 'permissions'],
    },
    execute: async (args, context) => {
      const { roleId, permissions, reason } = args;
      const { guild, member } = context;
      if (!hasPermission(member?.permissions, 'ManageRoles')) {
        return "Error: The user invoking this command does not have the Manage Roles permission.";
      }
      const cleanId = roleId.replace(/[<@&>]/g, '');
      let role = guild.roles.cache.get(cleanId);
      if (!role) {
        role = guild.roles.cache.find(r => r.name.toLowerCase() === roleId.toLowerCase());
      }
      if (!role) {
        return `Error: Role "${roleId}" not found.`;
      }

      const permissionBits = [];
      for (const perm of permissions) {
        if (PermissionFlagsBits[perm]) {
          permissionBits.push(PermissionFlagsBits[perm]);
        }
      }

      await role.setPermissions(permissionBits, reason || "No reason provided");
      return `Successfully set permissions for role "${role.name}": ${permissions.join(', ')}`;
    },
  },

  list_roles: {
    description: 'Lists all roles in the server with their properties.',
    permission: null,
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: [],
    },
    execute: async (args, context) => {
      const { guild } = context;
      const roles = guild.roles.cache
        .sort((a, b) => b.position - a.position)
        .map(r => `${r.name} (ID: ${r.id}, Color: ${r.hexColor}, Position: ${r.position}, Members: ${r.members.size})`)
        .join('\n');
      return `Server roles:\n${roles}`;
    },
  },

  get_member_roles: {
    description: 'Gets all roles of a specific member.',
    permission: null,
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: { type: 'STRING', description: 'The ID, @mention, username of the user.' },
      },
      required: ['userId'],
    },
    // buildContext removed
    execute: async (args, context) => {
      const { userId } = args;
      const { guild, member } = context;

      try {
        const targetMember = await resolveTargetMember(guild, userId, member);
        const roles = targetMember.roles.cache
          .filter(r => r.id !== guild.id)
          .map(r => r.name)
          .join(', ');
        return `${targetMember.user.tag} has roles: ${roles || 'None'}`;
      } catch (err) {
        return err.message.startsWith('Error:') ? err.message : `Error: ${err.message}`;
      }
    },
  },

  // === NICKNAME & USER MANAGEMENT ===

  set_nickname: {
    description: 'Sets or changes a member\'s nickname in the server.',
    permission: 'ManageNicknames',
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: { type: 'STRING', description: 'The ID, @mention, username of the user.' },
        nickname: { type: 'STRING', description: 'The new nickname (empty string to remove).' },
        reason: { type: 'STRING', description: 'The reason for changing nickname.' },
      },
      required: ['userId', 'nickname'],
    },
    // buildContext removed
    execute: async (args, context) => {
      const { userId, nickname, reason } = args;
      const { guild, member } = context;
      if (!hasPermission(member?.permissions, 'ManageNicknames')) {
        return "Error: The user invoking this command does not have the Manage Nicknames permission.";
      }

      try {
        const targetMember = await resolveTargetMember(guild, userId, member);
        await targetMember.setNickname(nickname || null, reason || "No reason provided");
        return `Successfully ${nickname ? `set nickname to "${nickname}"` : 'removed nickname'} for ${targetMember.user.tag}`;
      } catch (err) {
        return err.message.startsWith('Error:') ? err.message : `Error: ${err.message}`;
      }
    },
  },

  // === MESSAGE MANAGEMENT ===

  pin_message: {
    description: 'Pins a message in the channel.',
    permission: 'ManageMessages',
    parameters: {
      type: 'OBJECT',
      properties: {
        messageId: { type: 'STRING', description: 'The ID of the message to pin.' },
      },
      required: ['messageId'],
    },
    execute: async (args, context) => {
      const { messageId } = args;
      const { channel, member } = context;
      if (!hasPermission(member?.permissions, 'ManageMessages')) {
        return "Error: The user invoking this command does not have the Manage Messages permission.";
      }
      try {
        const message = await channel.messages.fetch(messageId);
        await message.pin();
        return `Successfully pinned message`;
      } catch (err) {
        return `Error pinning message: ${err.message}`;
      }
    },
  },

  unpin_message: {
    description: 'Unpins a message in the channel.',
    permission: 'ManageMessages',
    parameters: {
      type: 'OBJECT',
      properties: {
        messageId: { type: 'STRING', description: 'The ID of the message to unpin.' },
      },
      required: ['messageId'],
    },
    execute: async (args, context) => {
      const { messageId } = args;
      const { channel, member } = context;
      if (!hasPermission(member?.permissions, 'ManageMessages')) {
        return "Error: The user invoking this command does not have the Manage Messages permission.";
      }
      const message = await channel.messages.fetch(messageId);
      await message.unpin();
      return `Successfully unpinned message`;
    },
  },

  // === SERVER INFORMATION ===

  get_server_info: {
    description: 'Gets detailed information about the server.',
    permission: null,
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: [],
    },
    execute: async (args, context) => {
      const { guild } = context;
      return `Server: ${guild.name} (ID: ${guild.id})\nOwner: <@${guild.ownerId}>\nMembers: ${guild.memberCount}\nRoles: ${guild.roles.cache.size}\nChannels: ${guild.channels.cache.size}\nCreated: ${guild.createdAt.toDateString()}`;
    },
  },

  get_member_info: {
    description: 'Gets detailed information about a member.',
    permission: null,
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: { type: 'STRING', description: 'The ID of the user.' },
      },
      required: ['userId'],
    },
    execute: async (args, context) => {
      const { userId } = args;
      const { guild } = context;
      const cleanId = userId.replace(/[<@!>]/g, '');
      const targetMember = await guild.members.fetch(cleanId);
      const roles = targetMember.roles.cache
        .filter(r => r.id !== guild.id)
        .map(r => r.name)
        .join(', ');
      return `User: ${targetMember.user.tag} (${targetMember.user.id})\nNickname: ${targetMember.nickname || 'None'}\nJoined: ${targetMember.joinedAt?.toDateString()}\nRoles: ${roles || 'None'}\nTimeout: ${targetMember.isCommunicationDisabled() ? 'Yes' : 'No'}`;
    },
  },
};

module.exports = {
  actionsConfig,
};
