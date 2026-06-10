require("dotenv").config();
const {
	Client,
	EmbedBuilder,
	GatewayIntentBits,
	PermissionFlagsBits,
	REST,
	Routes,
	SlashCommandBuilder,
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseServiceRoleKey ? createClient(supabaseUrl, supabaseServiceRoleKey) : null;
const workTable = "work_items";

function normalizeText(value) {
	return String(value || "").trim();
}

function normalizeKey(value) {
	return normalizeText(value).toLowerCase();
}

function normalizeProgress(value, status) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) {
		return status === "done" ? 100 : 0;
	}

	const clamped = Math.max(0, Math.min(100, Math.round(numeric)));
	if (status === "done") {
		return 100;
	}

	return clamped;
}

function toRecord(row) {
	return {
		id: row.id,
		leadername: row.leadername,
		workowner: row.workowner,
		workname: row.workname,
		deadline: row.deadline,
		status: row.status,
		progress: row.progress,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

async function ensureSupabaseConfigured() {
	if (!supabase) {
		throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.");
	}
}

async function findWorkItemByName(workname) {
	await ensureSupabaseConfigured();

	const { data, error } = await supabase
		.from(workTable)
		.select("id, leadername, workowner, workname, deadline, status, progress, created_at, updated_at")
		.ilike("workname", workname)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();

	if (error) {
		throw error;
	}

	return data ? toRecord(data) : null;
	}

async function insertWorkItem(item) {
	await ensureSupabaseConfigured();

	const payload = {
		leadername: item.leadername,
		workowner: item.workowner,
		workname: item.workname,
		deadline: item.deadline,
		status: item.status,
		progress: item.progress,
		created_at: item.createdAt,
		updated_at: item.updatedAt,
	};

	const { data, error } = await supabase.from(workTable).insert(payload).select("id, leadername, workowner, workname, deadline, status, progress, created_at, updated_at").single();

	if (error) {
		throw error;
	}

	return toRecord(data);
}

function buildWorkEmbed(item) {
	return new EmbedBuilder()
		.setTitle(`Work Progress: ${item.workname}`)
		.setColor(item.status === "done" ? 0x2ecc71 : item.status === "progress" ? 0xf1c40f : 0xe67e22)
		.addFields(
			{ name: "Leader", value: item.leadername, inline: true },
			{ name: "Work Owner", value: item.workowner, inline: true },
			{ name: "Deadline", value: item.deadline, inline: true },
			{ name: "Status", value: item.status, inline: true },
			{ name: "Progress", value: `${item.progress}%`, inline: true },
			{ name: "Last Updated", value: `<t:${Math.floor(new Date(item.updatedAt).getTime() / 1000)}:F>`, inline: false }
		)
		.setFooter({ text: `Work ID: ${item.id}` });
}

function buildCommands() {
	return [
		new SlashCommandBuilder()
			.setName("work")
			.setDescription("Track work items and progress")
			.addSubcommand((subcommand) =>
				subcommand
					.setName("add")
					.setDescription("Add a work item")
					.addStringOption((option) => option.setName("leadername").setDescription("Leader name").setRequired(true))
					.addStringOption((option) => option.setName("workowner").setDescription("Work owner name").setRequired(true))
					.addStringOption((option) => option.setName("workname").setDescription("Work name").setRequired(true))
					.addStringOption((option) => option.setName("deadline").setDescription("Deadline").setRequired(true))
					.addStringOption((option) =>
						option
							.setName("status")
							.setDescription("Current status")
							.setRequired(true)
							.addChoices(
								{ name: "todo", value: "todo" },
								{ name: "progress", value: "progress" },
								{ name: "done", value: "done" }
							)
					)
					.addIntegerOption((option) => option.setName("progress").setDescription("Progress percentage").setMinValue(0).setMaxValue(100).setRequired(true))
			)
			.addSubcommand((subcommand) =>
				subcommand
					.setName("check")
					.setDescription("Check progress for a work item")
					.addStringOption((option) => option.setName("workname").setDescription("Work name to check").setRequired(true))
			)
			.toJSON(),
	];
}

async function registerCommands() {
	if (!token || !clientId) {
		console.warn("DISCORD_TOKEN and DISCORD_CLIENT_ID are required to register slash commands.");
		return;
	}

	if (!supabase) {
		console.warn("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for work storage.");
	}

	const rest = new REST({ version: "10" }).setToken(token);
	const commands = buildCommands();

	if (guildId) {
		await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
		console.log(`Registered commands for guild ${guildId}`);
		return;
	}

	await rest.put(Routes.applicationCommands(clientId), { body: commands });
	console.log("Registered global slash commands");
}

client.once("ready", async () => {
	try {
		await registerCommands();
	} catch (error) {
		console.error("Failed to register commands:", error);
	}

	console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
	if (!interaction.isChatInputCommand() || interaction.commandName !== "work") {
		return;
	}

	try {
		if (interaction.options.getSubcommand() === "add") {
			const leadername = normalizeText(interaction.options.getString("leadername", true));
			const workowner = normalizeText(interaction.options.getString("workowner", true));
			const workname = normalizeText(interaction.options.getString("workname", true));
			const deadline = normalizeText(interaction.options.getString("deadline", true));
			const status = interaction.options.getString("status", true);
			const progress = normalizeProgress(interaction.options.getInteger("progress", true), status);

			const duplicate = await findWorkItemByName(workname);

			if (duplicate) {
				await interaction.reply({ content: `A work item named "${workname}" already exists.`, ephemeral: true });
				return;
			}

			const now = new Date().toISOString();
			const item = {
				id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
				leadername,
				workowner,
				workname,
				deadline,
				status,
				progress,
				createdAt: now,
				updatedAt: now,
			};

			const savedItem = await insertWorkItem(item);

			await interaction.reply({
				content: `Saved work item "${workname}" with status ${status} and progress ${progress}%.`,
				embeds: [buildWorkEmbed(savedItem)],
			});
			return;
		}

		if (interaction.options.getSubcommand() === "check") {
			const workname = normalizeText(interaction.options.getString("workname", true));
			const item = await findWorkItemByName(workname);

			if (!item) {
				await interaction.reply({ content: `No work item found for "${workname}".`, ephemeral: true });
				return;
			}

			const requesterName = normalizeKey(interaction.member?.displayName || interaction.user.username);
			const leaderName = normalizeKey(item.leadername);
			const ownerName = normalizeKey(item.workowner);
			const isPrivileged =
				requesterName === leaderName ||
				requesterName === ownerName ||
				interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

			if (!isPrivileged) {
				await interaction.reply({
					content: "Only the recorded leader, work owner, or a server manager can check this item.",
					ephemeral: true,
				});
				return;
			}

			await interaction.reply({ embeds: [buildWorkEmbed(item)] });
		}
	} catch (error) {
		console.error("Interaction failed:", error);
		const message = "Something went wrong while handling that work command.";

		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
			return;
		}

		await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
	}
});

if (!token) {
	console.error("Missing DISCORD_TOKEN in the environment.");
	process.exit(1);
}

if (!supabase) {
	console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.");
	process.exit(1);
}

client.login(token);