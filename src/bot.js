require("dotenv").config();
const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	Client,
	AttachmentBuilder,
	EmbedBuilder,
	GatewayIntentBits,
	PermissionFlagsBits,
	REST,
	ModalBuilder,
	Routes,
	TextInputBuilder,
	TextInputStyle,
	SlashCommandBuilder,
} = require("discord.js");
const { Pool } = require("pg");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const databaseUrl = process.env.DATABASE_URL;
const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
const pool = databaseUrl
	? new Pool({
		connectionString: databaseUrl,
		ssl: databaseUrl.includes("supabase.co") ? { rejectUnauthorized: false } : undefined,
	})
	: null;
const workTable = "work_items";
const geoGames = new Map();
const geoGameLifetimeMs = 10 * 60 * 1000;
const geoMetadataUrl = "https://maps.googleapis.com/maps/api/streetview/metadata";
const geoImageUrl = "https://maps.googleapis.com/maps/api/streetview";
const geoGeocodeUrl = "https://maps.googleapis.com/maps/api/geocode/json";

function normalizeText(value) {
	return String(value || "").trim();
}

function readTextOption(interaction, name) {
	return normalizeText(interaction.options.getString(name));
}

function readIntegerOption(interaction, name) {
	const value = interaction.options.getInteger(name);
	return Number.isFinite(value) ? value : null;
}

function normalizeKey(value) {
	return normalizeText(value).toLowerCase();
}

function randomBetween(min, max) {
	return Math.random() * (max - min) + min;
}

function randomGeoId() {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function formatGeoGuessDistance(distanceKm) {
	if (distanceKm < 1) {
		return `${Math.round(distanceKm * 1000)} m`;
	}

	return `${distanceKm.toFixed(distanceKm < 10 ? 2 : 1)} km`;
}

function parseCoordinateGuess(value) {
	const cleaned = normalizeText(value)
		.replace(/°/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const coordinateMatch = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);

	if (!coordinateMatch) {
		return null;
	}

	const latitude = Number(coordinateMatch[1]);
	const longitude = Number(coordinateMatch[2]);

	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
		return null;
	}

	if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
		return null;
	}

	return { latitude, longitude };
}

function haversineDistanceKm(startLatitude, startLongitude, endLatitude, endLongitude) {
	const earthRadiusKm = 6371;
	const toRadians = (degrees) => (degrees * Math.PI) / 180;
	const latitudeDelta = toRadians(endLatitude - startLatitude);
	const longitudeDelta = toRadians(endLongitude - startLongitude);
	const startLatitudeRadians = toRadians(startLatitude);
	const endLatitudeRadians = toRadians(endLatitude);
	const a =
		Math.sin(latitudeDelta / 2) * Math.sin(latitudeDelta / 2) +
		Math.cos(startLatitudeRadians) * Math.cos(endLatitudeRadians) * Math.sin(longitudeDelta / 2) * Math.sin(longitudeDelta / 2);

	return 2 * earthRadiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildGeoStreetViewUrl(latitude, longitude, heading) {
	const params = new URLSearchParams({
		size: "800x450",
		location: `${latitude},${longitude}`,
		fov: "90",
		heading: String(Math.round(heading)),
		pitch: "0",
		key: googleMapsApiKey,
	});

	return `${geoImageUrl}?${params.toString()}`;
}

function buildGeoGuessButton(gameId) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(`playgeo:guess:${gameId}`).setLabel("Submit Guess").setStyle(ButtonStyle.Primary)
	);
}

function buildGeoGuessModal(gameId) {
	const input = new TextInputBuilder()
		.setCustomId(`playgeo:guess-input:${gameId}`)
		.setLabel("Your guess")
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(true)
		.setPlaceholder("Type a place name, address, or coordinates like 51.5, -0.12");

	return new ModalBuilder()
		.setCustomId(`playgeo:modal:${gameId}`)
		.setTitle("Submit your guess")
		.addComponents(new ActionRowBuilder().addComponents(input));
}

async function fetchJson(url) {
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Request failed with status ${response.status}`);
	}

	return response.json();
}

async function fetchStreetViewMetadata(latitude, longitude) {
	const params = new URLSearchParams({
		location: `${latitude},${longitude}`,
		key: googleMapsApiKey,
	});

	return fetchJson(`${geoMetadataUrl}?${params.toString()}`);
}

async function geocodeGuessToCoordinates(guess) {
	const directCoordinateGuess = parseCoordinateGuess(guess);

	if (directCoordinateGuess) {
		return directCoordinateGuess;
	}

	const params = new URLSearchParams({
		address: guess,
		key: googleMapsApiKey,
	});
	const result = await fetchJson(`${geoGeocodeUrl}?${params.toString()}`);

	if (result.status !== "OK" || !Array.isArray(result.results) || !result.results.length) {
		return null;
	}

	const location = result.results[0]?.geometry?.location;

	if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
		return null;
	}

	return { latitude: location.lat, longitude: location.lng };
}

async function createGeoGame() {
	if (!googleMapsApiKey) {
		throw new Error("Missing GOOGLE_MAPS_API_KEY in the environment.");
	}

	for (let attempt = 0; attempt < 8; attempt += 1) {
		const seedLatitude = randomBetween(-60, 75);
		const seedLongitude = randomBetween(-180, 180);
		const metadata = await fetchStreetViewMetadata(seedLatitude, seedLongitude);
		console.log(metadata);
		if (metadata.status !== "OK" || !metadata.location) {
			continue;
		}

		const latitude = Number(metadata.location.lat);
		const longitude = Number(metadata.location.lng);

		if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
			continue;
		}

		return {
			latitude,
			longitude,
			heading: Math.random() * 360,
		};
	}

	throw new Error("Could not find a Street View location for the game.");
}

function storeGeoGame(game) {
	geoGames.set(game.id, game);
	game.timeout = setTimeout(() => {
		geoGames.delete(game.id);
	}, geoGameLifetimeMs);
	game.timeout.unref?.();
}

function clearGeoGame(gameId) {
	const game = geoGames.get(gameId);

	if (game?.timeout) {
		clearTimeout(game.timeout);
	}

	geoGames.delete(gameId);
}

function getGeoGame(gameId) {
	const game = geoGames.get(gameId);

	if (!game) {
		return null;
	}

	if (Date.now() - game.createdAt > geoGameLifetimeMs) {
		clearGeoGame(gameId);
		return null;
	}

	return game;
}

async function handlePlayGeoCommand(interaction) {
	if (!googleMapsApiKey) {
		await interaction.reply({
			content: "Missing GOOGLE_MAPS_API_KEY in the environment. Add it to generate Street View games.",
			ephemeral: true,
		});
		return;
	}

	await interaction.deferReply();

	const game = await createGeoGame();
	const gameId = randomGeoId();
	const latitude = Number(game.latitude);
	const longitude = Number(game.longitude);

	storeGeoGame({
		id: gameId,
		ownerId: interaction.user.id,
		channelId: interaction.channelId,
		messageId: null,
		latitude,
		longitude,
		createdAt: Date.now(),
	});

	await interaction.editReply({
		content: `${interaction.user} started a GeoGuess round. Click Submit Guess when you have an answer.`,
		embeds: [
			new EmbedBuilder()
				.setTitle("GeoGuess")
				.setDescription("Study the Street View image and submit your best guess.")
				.setColor(0x1abc9c)
				.setImage(buildGeoStreetViewUrl(latitude, longitude, game.heading))
				.setFooter({ text: "Guess with a place name or coordinates" }),
		],
		components: [buildGeoGuessButton(gameId)],
	});

	const replyMessage = await interaction.fetchReply();
	const storedGame = getGeoGame(gameId);

	if (storedGame) {
		storedGame.messageId = replyMessage.id;
	}
}

async function handleGeoGuessButton(interaction) {
	const gameId = interaction.customId.split(":").slice(2).join(":");
	const game = getGeoGame(gameId);

	if (!game) {
		await interaction.reply({ content: "That GeoGuess game has expired. Start a new one with /playgeo.", ephemeral: true });
		return;
	}

	if (interaction.user.id !== game.ownerId) {
		await interaction.reply({ content: "Only the player who started this game can submit the guess.", ephemeral: true });
		return;
	}

	await interaction.showModal(buildGeoGuessModal(gameId));
}

async function handleGeoGuessModal(interaction) {
	const gameId = interaction.customId.split(":").slice(2).join(":");
	const game = getGeoGame(gameId);

	if (!game) {
		await interaction.reply({ content: "That GeoGuess game has expired. Start a new one with /playgeo.", ephemeral: true });
		return;
	}

	if (interaction.user.id !== game.ownerId) {
		await interaction.reply({ content: "Only the player who started this game can submit the guess.", ephemeral: true });
		return;
	}

	const guess = normalizeText(interaction.fields.getTextInputValue(`playgeo:guess-input:${gameId}`));

	if (!guess) {
		await interaction.reply({ content: "Please enter a location guess.", ephemeral: true });
		return;
	}

	await interaction.deferReply({ ephemeral: true });

	try {
		const guessedCoordinates = await geocodeGuessToCoordinates(guess);

		if (!guessedCoordinates) {
			await interaction.editReply({ content: "I could not resolve that guess. Try a clearer place name or coordinates like 51.5, -0.12." });
			return;
		}

		const distanceKm = haversineDistanceKm(
			guessedCoordinates.latitude,
			guessedCoordinates.longitude,
			game.latitude,
			game.longitude
		);

		await interaction.editReply({
			content: `Your guess is ${formatGeoGuessDistance(distanceKm)} away from the Street View location.\nAnswer: ${game.latitude.toFixed(5)}, ${game.longitude.toFixed(5)}`,
		});

		if (game.channelId && game.messageId) {
			const channel = await client.channels.fetch(game.channelId).catch(() => null);
			const originalMessage = channel?.messages?.fetch ? await channel.messages.fetch(game.messageId).catch(() => null) : null;

			if (originalMessage) {
				await originalMessage.edit({
					content: `${originalMessage.content}\n\nSolved by ${interaction.user}.`,
					components: [],
				}).catch(() => {});
			}
		}
	} finally {
		clearGeoGame(gameId);
	}
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

function statusFromProgress(progress) {
	if (progress <= 0) {
		return "todo";
	}

	if (progress >= 100) {
		return "done";
	}

	return "progress";
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
	if (!pool) {
		throw new Error("Missing DATABASE_URL in the environment.");
	}
}

async function initializeDatabase() {
	await ensureSupabaseConfigured();

	await pool.query(`
		create table if not exists public.${workTable} (
			id bigint generated by default as identity primary key,
			leadername text not null,
			workowner text not null,
			workname text not null,
			deadline text not null,
			status text not null check (status in ('todo', 'progress', 'done')),
			progress integer not null default 0 check (progress >= 0 and progress <= 100),
			created_at timestamptz not null default now(),
			updated_at timestamptz not null default now()
		)
	`);

	await pool.query(`alter table public.${workTable} drop constraint if exists work_items_workname_key`);
	await pool.query(`create unique index if not exists work_items_workname_owner_idx on public.${workTable} (workname, workowner)`);
	await pool.query(`create index if not exists work_items_owner_idx on public.${workTable} (workowner)`);
}

async function findWorkItemByName(workname, workowner) {
	await ensureSupabaseConfigured();

	const { rows } = await pool.query(
		`select id, leadername, workowner, workname, deadline, status, progress, created_at, updated_at
		 from public.${workTable}
		 where workname ilike $1 and workowner ilike $2
		 order by created_at desc
		 limit 1`,
		[workname, workowner]
	);

	return rows[0] ? toRecord(rows[0]) : null;
	}

async function findWorkItemsByOwner(workowner) {
	await ensureSupabaseConfigured();

	const { rows } = await pool.query(
		`select id, leadername, workowner, workname, deadline, status, progress, created_at, updated_at
		 from public.${workTable}
		 where workowner ilike $1
		 order by created_at desc`,
		[workowner]
	);

	return rows.map(toRecord);
}

async function findWorkItemsByLeader(leadername) {
	await ensureSupabaseConfigured();
	const leadernameWithAt = `@${leadername}`;
	const { rows } = await pool.query(
		`select id, leadername, workowner, workname, deadline, status, progress, created_at, updated_at
		 from public.${workTable}
		 where leadername ilike $1
		    or leadername ilike $2
		 order by workowner asc, workname asc`,
		[leadername, leadernameWithAt]
	);

	return rows.map(toRecord);
}

async function findWorkItemsForRequester(interaction) {
	const displayName = normalizeText(interaction.member?.displayName);
	const username = normalizeText(interaction.user.username);
	const { rows } = await pool.query(
		`select id, leadername, workowner, workname, deadline, status, progress, created_at, updated_at
		 from public.${workTable}
		 where lower(workowner) = lower($1)
		    or lower(workowner) = lower($2)
		 order by created_at desc`,
		[displayName, username]
	);

	return rows.map(toRecord);
}

async function insertWorkItem(item) {
	await ensureSupabaseConfigured();

	const { rows } = await pool.query(
		`insert into public.${workTable} (
			leadername,
			workowner,
			workname,
			deadline,
			status,
			progress,
			created_at,
			updated_at
		) values ($1, $2, $3, $4, $5, $6, $7, $8)
		returning id, leadername, workowner, workname, deadline, status, progress, created_at, updated_at`,
		[
			item.leadername,
			item.workowner,
			item.workname,
			item.deadline,
			item.status,
			item.progress,
			item.createdAt,
			item.updatedAt,
		]
	);

	return toRecord(rows[0]);
}

async function updateWorkItemProgress(workname, progress) {
	await ensureSupabaseConfigured();

	const status = statusFromProgress(progress);
	const { rows } = await pool.query(
		`update public.${workTable}
		 set progress = $1,
		     status = $2,
		     updated_at = now()
		 where lower(workname) = lower($3)
		 returning id, leadername, workowner, workname, deadline, status, progress, created_at, updated_at`,
		[progress, status, workname]
	);

	return rows[0] ? toRecord(rows[0]) : null;
}

async function cleanupOldWorkItems() {
	await ensureSupabaseConfigured();

	const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

	const { rowCount } = await pool.query(
		`delete from public.${workTable}
		 where (status = 'done' and updated_at < $1)
		    or (updated_at < $2)`,
		[sevenDaysAgo, thirtyDaysAgo]
	);

	if (rowCount > 0) {
		console.log(`Cleaned up ${rowCount} old work items.`);
	}
}

function csvEscape(value) {
	const text = String(value ?? "");
	if (/[",\n\r]/.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}

	return text;
}

function buildWorkCsv(items) {
	const header = ["leadername", "workowner", "workname", "deadline", "status", "progress"];
	const rows = items.map((item) => [
		item.leadername,
		item.workowner,
		item.workname,
		item.deadline,
		item.status,
		item.progress,
	]);

	return [header, ...rows]
		.map((row) => row.map(csvEscape).join(","))
		.join("\n");
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
					.addStringOption((option) => option.setName("workname").setDescription("Work name").setRequired(true))
					.addStringOption((option) => option.setName("deadline").setDescription("Deadline").setRequired(true))
			)
			.addSubcommand((subcommand) =>
				subcommand
					.setName("check")
					.setDescription("Check your work items")
			)
			.addSubcommand((subcommand) =>
				subcommand
					.setName("update")
					.setDescription("Update progress for a work item")
					.addStringOption((option) => option.setName("workname").setDescription("Work name to update").setRequired(true))
					.addIntegerOption((option) =>
						option
							.setName("progress")
							.setDescription("New progress percentage")
							.setMinValue(0)
							.setMaxValue(100)
							.setRequired(true)
					)
			)
			.toJSON(),
		new SlashCommandBuilder()
			.setName("playgeo")
			.setDescription("Start a GeoGuess game using Google Street View")
			.toJSON(),
		new SlashCommandBuilder()
			.setName("leader")
			.setDescription("Leader tools")
			.addSubcommand((subcommand) =>
				subcommand
					.setName("export")
					.setDescription("Export all work you lead as CSV")
			)
			.toJSON(),
	];
}

async function registerCommands() {
	if (!token || !clientId) {
		console.warn("DISCORD_TOKEN and DISCORD_CLIENT_ID are required to register slash commands.");
		return;
	}

	if (!pool) {
		console.warn("DATABASE_URL is required for work storage.");
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

client.once("clientReady", async () => {
	try {
		await initializeDatabase();
		await registerCommands();
		await cleanupOldWorkItems();

		setInterval(async () => {
			try {
				await cleanupOldWorkItems();
			} catch (error) {
				console.error("Cleanup failed:", error);
			}
		}, 60 * 60 * 1000); // Run cleanup every hour
	} catch (error) {
		console.error("Failed to register commands:", error);
	}

	console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
	if (interaction.isButton() && interaction.customId.startsWith("playgeo:guess:")) {
		try {
			await handleGeoGuessButton(interaction);
		} catch (error) {
			console.error("GeoGuess button failed:", error);
			if (!interaction.replied && !interaction.deferred) {
				await interaction.reply({ content: "Something went wrong while opening the guess form.", ephemeral: true }).catch(() => {});
			}
		}

		return;
	}

	if (interaction.isModalSubmit() && interaction.customId.startsWith("playgeo:modal:")) {
		try {
			await handleGeoGuessModal(interaction);
		} catch (error) {
			console.error("GeoGuess modal failed:", error);
			if (interaction.deferred || interaction.replied) {
				await interaction.followUp({ content: "Something went wrong while checking your guess.", ephemeral: true }).catch(() => {});
			} else {
				await interaction.reply({ content: "Something went wrong while checking your guess.", ephemeral: true }).catch(() => {});
			}
		}

		return;
	}

	if (interaction.isChatInputCommand() && interaction.commandName === "playgeo") {
		try {
			await handlePlayGeoCommand(interaction);
		} catch (error) {
			console.error("GeoGuess setup failed:", error);
			const message = googleMapsApiKey
				? "Something went wrong while starting GeoGuess."
				: "Missing GOOGLE_MAPS_API_KEY in the environment.";

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
				return;
			}

			await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
		}

		return;
	}

	if (!interaction.isChatInputCommand() || (interaction.commandName !== "work" && interaction.commandName !== "leader")) {
		return;
	}

	try {
		if (interaction.options.getSubcommand() === "add") {
			const leadername = readTextOption(interaction, "leadername");
			const workname = readTextOption(interaction, "workname");
			const deadline = readTextOption(interaction, "deadline");
			const workowner = normalizeText(interaction.member?.displayName || interaction.user.username);

			if (!leadername || !workname || !deadline) {
				await interaction.reply({
					content: "Missing required work details. Please provide leadername, workname, and deadline.",
					ephemeral: true,
				});
				return;
			}

			const duplicate = await findWorkItemByName(workname, workowner);

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
				status: "todo",
				progress: 0,
				createdAt: now,
				updatedAt: now,
			};

			const savedItem = await insertWorkItem(item);

			await interaction.reply({
				content: `Saved work item "${workname}" as todo with progress 0%.`,
				embeds: [buildWorkEmbed(savedItem)],
			});
			return;
		}

		if (interaction.options.getSubcommand() === "check") {
			const displayName = normalizeText(interaction.member?.displayName);
			const username = normalizeText(interaction.user.username);
			const items = await findWorkItemsForRequester(interaction);
			const ownerLabel = `${displayName || username}`;

			if (!items.length) {
				await interaction.reply({ content: `No work items found for "${ownerLabel}".`, ephemeral: true });
				return;
			}

			const summaryLines = items.map(
				(item) =>
					`• ${item.workname} | leader: ${item.leadername} | ${item.status} | ${item.progress}% | deadline: ${item.deadline}`
			);

			await interaction.reply({
				embeds: [
					new EmbedBuilder()
						.setTitle(`Work items for ${ownerLabel}`)
						.setColor(0x3498db)
						.setDescription(summaryLines.join("\n").slice(0, 4096))
						.setFooter({ text: `Total items: ${items.length}` }),
				],
			});
			return;
		}

		if (interaction.options.getSubcommand() === "update") {
			const workname = readTextOption(interaction, "workname");
			const progressValue = readIntegerOption(interaction, "progress");

			if (!workname || progressValue === null) {
				await interaction.reply({
					content: "Missing required update details. Please provide workname and progress.",
					ephemeral: true,
				});
				return;
			}

			const progress = normalizeProgress(progressValue, "progress");
			const ownerName = normalizeText(interaction.member?.displayName || interaction.user.username);
			const item = await findWorkItemByName(workname, ownerName);

			if (!item) {
				await interaction.reply({ content: `No work item found for "${workname}".`, ephemeral: true });
				return;
			}

			const requesterName = normalizeKey(interaction.member?.displayName || interaction.user.username);
			const ownerNameKey = normalizeKey(item.workowner);
			const isPrivileged = requesterName === ownerNameKey || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

			if (!isPrivileged) {
				await interaction.reply({
					content: "Only the work owner or a server manager can update this item.",
					ephemeral: true,
				});
				return;
			}

			const updatedItem = await updateWorkItemProgress(workname, progress);

			if (!updatedItem) {
				await interaction.reply({ content: `No work item found for "${workname}".`, ephemeral: true });
				return;
			}

			await interaction.reply({
				content: `Updated "${updatedItem.workname}" to ${updatedItem.progress}% (${updatedItem.status}).`,
				embeds: [buildWorkEmbed(updatedItem)],
			});
			return;
		}

		if (interaction.commandName === "leader" && interaction.options.getSubcommand() === "export") {
			const displayName = normalizeText(interaction.member?.displayName);
			const username = normalizeText(interaction.user.username);
			const leaderLabel = displayName || username;
			const items = await findWorkItemsByLeader(displayName || username);

			if (!items.length) {
				await interaction.reply({ content: `No work items found for leader "${leaderLabel}".`, ephemeral: true });
				return;
			}

			const csv = buildWorkCsv(items);
			const fileName = `${leaderLabel.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "work_items"}.csv`;
			const file = new AttachmentBuilder(Buffer.from(csv, "utf8"), { name: fileName });

			await interaction.reply({
				content: `Exported ${items.length} work item(s) for ${leaderLabel}.`,
				files: [file],
			});
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

if (!pool) {
	console.error("Missing DATABASE_URL in the environment.");
	process.exit(1);
}

client.login(token);