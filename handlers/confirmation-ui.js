// filepath: handlers/confirmation-ui.js
// Handles action confirmation UI and button interactions

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} = require('discord.js');

/**
 * Format action arguments into user-friendly readable text
 * @param {object} args - Action arguments
 * @param {import('discord.js').Guild} guild - Discord guild
 * @returns {Promise<string>}
 */
async function formatActionDetails(args, guild) {
  const details = [];

  // Handle userId fields (member targeting)
  if (args.userId) {
    try {
      // Remove <@!> from user ID (standard Discord mention format)
      const cleanId = args.userId.replace(/[<@!>]/g, '');

      // Try to fetch guild member by ID first
      let member = await guild?.members.fetch(cleanId).catch(() => null);

      // If not found by ID AND the input doesn't look like a valid ID (17-19 digits), try username/nickname
      if (!member && !/^\d{17,19}$/.test(cleanId)) {

        // Convert name to lowercase 
        const searchName = cleanId.toLowerCase();
        try {
          // Use Discord's native search API (better than fetching all members)
          const searchResults = await guild?.members.fetch({ query: cleanId, limit: 5 });

          if (searchResults && searchResults.size > 0) {

            // Find EXACT matches first from the search results
            let exactMatches = searchResults.filter(m =>
              m.user.username.toLowerCase() === searchName ||
              m.user.tag.toLowerCase() === searchName ||
              (m.nickname && m.nickname.toLowerCase() === searchName) ||
              (m.user.globalName && m.user.globalName.toLowerCase() === searchName)
            );

            // If we at least found one exact match
            if (exactMatches.size > 0) {

              // If exactly one user matches, select them
              if (exactMatches.size === 1) {
                member = exactMatches.first();
              } else {
                // If found multiple exact matches, warn user to be more specific and stop processing
                member = null;
                details.push(`👤 **Target:** "${args.userId}"\n⚠️ **Ambiguous:** Matches ${exactMatches.size} users. Please use ID.`);
                return details.join('\n'); // Exit function and return warning string
              }
            } else {
              // If no exact match, the API search results are already "partial matches"
              // So if exactly one partial match, select it
              if (searchResults.size === 1) {
                member = searchResults.first();
              } else {
                // If found multiple partial matches, warn user to be more specific and stop processing
                member = null;
                details.push(`👤 **Target:** "${args.userId}"\n⚠️ **Ambiguous:** Matches multiple users. Please filter more specific.`);
                return details.join('\n'); // Exit function and return warning string
              }
            }
          }
        } catch (e) {
          // Ignore API errors
        }
      }

      // If a valid member was successfully resolved
      if (member) {
        // Format: User: @mention (ID)
        details.push(`👤 **User:** <@${member.user.id}> <\`${member.user.id}\`>`);
      } else {
        // If no valid member was found, add a warning message
        details.push(`👤 **Target:** "${args.userId}"\n⚠️ **Warning:** User not found. Action may fail.`);
      }
    } catch (e) { // If any unexpected error occurs in the entire user resolution process
      details.push(`👤 **User ID:** ${args.userId} (Error resolving)`);
    }
  }

  // Handle roleId fields (role targeting)
  if (args.roleId) {
    try {
      const cleanId = args.roleId.replace(/[<@&>]/g, '');
      let role = guild?.roles.cache.get(cleanId);
      if (!role) {
        role = guild?.roles.cache.find(r => r.name.toLowerCase() === args.roleId.toLowerCase());
      }
      if (role) {
        details.push(`🏷️ **Role:** ${role.name} (${role.id})`);
      } else {
        details.push(`🏷️ **Role ID:** ${args.roleId}`);
      }
    } catch (e) {
      details.push(`🏷️ **Role ID:** ${args.roleId}`);
    }
  }

  // Handle messageId fields
  if (args.messageId) {
    details.push(`💬 **Message ID:** ${args.messageId}`);
  }

  // Handle amount fields (bulk operations)
  if (args.amount !== undefined) {
    details.push(`📊 **Amount:** ${args.amount}`);
  }

  // Handle duration fields
  if (args.duration !== undefined) {
    details.push(`⏱️ **Duration:** ${args.duration} minutes`);
  }

  // Handle reason fields
  if (args.reason) {
    details.push(`📝 **Reason:** ${args.reason}`);
  }

  // Handle nickname changes
  if (args.nickname !== undefined) {
    details.push(`📛 **New Nickname:** ${args.nickname || '(removed)'}`);
  }

  // Handle role creation parameters
  if (args.name && !args.userId && !args.roleId) {
    details.push(`📝 **Name:** ${args.name}`);
  }

  if (args.color) {
    details.push(`🎨 **Color:** ${args.color}`);
  }

  if (args.hoist !== undefined) {
    details.push(`📌 **Display Separately:** ${args.hoist ? 'Yes' : 'No'}`);
  }

  if (args.mentionable !== undefined) {
    details.push(`🔔 **Mentionable:** ${args.mentionable ? 'Yes' : 'No'}`);
  }

  if (args.deleteMessageDays !== undefined) {
    details.push(`🗑️ **Delete Messages:** ${args.deleteMessageDays} days`);
  }

  // Handle permissions array
  if (args.permissions && Array.isArray(args.permissions)) {
    details.push(`🔐 **Permissions:** ${args.permissions.join(', ')}`);
  }

  return details.length > 0 ? details.join('\n') : 'No additional details';
}

/**
 * Show action confirmation dialog to user
 * @param {object} params
 * @param {string} params.actionName - Display name of the action (e.g., "Delete Messages")
 * @param {string} params.requiredPerm - Discord permission name required
 * @param {object} params.args - Action arguments to display
 * @param {string} params.initialText - Initial response text from model
 * @param {import('discord.js').Message} params.discordMessage - Discord message to edit
 * @param {import('discord.js').Guild} params.guild - Discord guild
 * @returns {Promise<{confirmed: boolean, reason: string}>}
 */
async function showConfirmationDialog({
  actionName,
  requiredPerm,
  args,
  initialText,
  discordMessage,
  senderUserId,
  guild,
}) {
  const formattedDetails = await formatActionDetails(args, guild);

  const confirmEmbed = new EmbedBuilder()
    .setTitle('⚠️ Action Confirmation')
    .setColor(0xFFA500)
    .addFields(
      { name: 'Action', value: actionName, inline: false },
      { name: 'Details', value: formattedDetails || 'No details provided', inline: false }
    )
    .setFooter({ text: `Requires Permission: ${requiredPerm}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('confirm_action')
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('cancel_action')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  await discordMessage.edit({
    content: initialText,
    embeds: [confirmEmbed],
    components: [row],
  });

  const collector = discordMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60000,
  });

  return new Promise((resolve) => {
    collector.on('collect', async (i) => {
      // Only the original sender can confirm/cancel
      if (i.user.id !== senderUserId) {
        return i.reply({
          content: "⛔ This isn't your request.",
          ephemeral: true
        });
      }

      if (i.customId === 'confirm_action') {
        await i.deferUpdate();
        collector.stop('confirmed');
        resolve({ confirmed: true, reason: 'confirmed' });

      } else if (i.customId === 'cancel_action') {
        await i.deferUpdate();
        collector.stop('cancelled');
        resolve({ confirmed: false, reason: 'cancelled' });
      }
    });

    collector.on('end', async (collected, reason) => {
      if (reason === 'time') {

        resolve({ confirmed: false, reason: 'timeout' });
      }
    });
  });
}

/**
 * Remove confirmation UI (embeds and buttons) from message
 * @param {import('discord.js').Message} message - Discord message
 * @param {string} content - New content
 * @returns {Promise<void>}
 */
async function clearConfirmationUI(message, content) {
  await message.edit({
    content: content,
    embeds: [],
    components: []
  }).catch(() => { });
}

module.exports = {
  showConfirmationDialog,
  clearConfirmationUI,
};
