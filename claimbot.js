const async = require("async");
const axios = require("axios");
const { cyan, green, magenta, red, yellow } = require("chalk");
const { Api } = require("eosjs/dist/eosjs-api");
const { JsonRpc } = require("eosjs/dist/eosjs-jsonrpc");
const { JsSignatureProvider } = require("eosjs/dist/eosjs-jssig");
const { PrivateKey } = require("eosjs/dist/eosjs-key-conversions");
const { dateToTimePointSec, timePointSecToDate } = require("eosjs/dist/eosjs-serialize");
const fs = require("mz/fs");
const _ = require("lodash");
const fetch = require("node-fetch");
const os = require("os");
const path = require("path");
const { TextDecoder, TextEncoder } = require("util");

require("dotenv").config();

const WAX_ENDPOINTS = _.shuffle([
	// "https://api.wax.greeneosio.com",
	"https://api.waxsweden.org",
	"https://wax.cryptolions.io",
	"https://wax.eu.eosamsterdam.net",
	"https://api-wax.eosarabia.net",
	"https://wax.greymass.com",
	"https://wax.pink.gg",
]);

const ATOMIC_ENDPOINTS = _.shuffle([
	"https://aa.wax.blacklusion.io",
	"https://wax-atomic-api.eosphere.io",
	"https://wax.api.atomicassets.io",
	"https://wax.blokcrafters.io",
]);

const Configs = {
	WAXEndpoints: [...WAX_ENDPOINTS],
	atomicEndpoints: [...ATOMIC_ENDPOINTS],
};

async function shuffleEndpoints() {
	// shuffle endpoints to avoid spamming a single one
	Configs.WAXEndpoints = _.shuffle(WAX_ENDPOINTS);
	Configs.atomicEndpoints = _.shuffle(ATOMIC_ENDPOINTS);
}

/**
 *
 * @param {number} t in seconds
 * @returns {Promise<void>}
 */
async function waitFor(t) {
	return new Promise(resolve => setTimeout(() => resolve(), t * 1e3));
}

function parseRemainingTime(millis) {
	const diff = Math.floor(millis / 1e3);
	const hours = Math.floor(diff / 3600);
	const minutes = Math.floor((diff % 3600) / 60);
	const seconds = Math.floor((diff % 3600) % 60);
	const time = [
		hours > 0 && `${hours.toString().padStart(2, "0")} hours`,
		minutes > 0 && `${minutes.toString().padStart(2, "0")} minutes`,
		seconds > 0 && `${seconds.toString().padStart(2, "0")} seconds`,
	]
		.filter(n => !!n)
		.join(", ");

	return time;
}

function logTask(...message) {
	console.log(`${yellow("Task")}`, ...message);
	console.log("-".repeat(32));
}

async function transact(config) {
	const { DEV_MODE } = process.env;
	if (DEV_MODE == 1) {
		return;
	}

	try {
		const endpoint = _.sample(Configs.WAXEndpoints);
		const rpc = new JsonRpc(endpoint, { fetch });

		const accountAPI = new Api({
			rpc,
			signatureProvider: new JsSignatureProvider(config.privKeys),
			textEncoder: new TextEncoder(),
			textDecoder: new TextDecoder(),
		});

		const info = await rpc.get_info();
		const subId = info.head_block_id.substr(16, 8);
		const prefix = parseInt(subId.substr(6, 2) + subId.substr(4, 2) + subId.substr(2, 2) + subId.substr(0, 2), 16);

		const transaction = {
			expiration: timePointSecToDate(dateToTimePointSec(info.head_block_time) + 3600),
			ref_block_num: 65535 & info.head_block_num,
			ref_block_prefix: prefix,
			actions: await accountAPI.serializeActions(config.actions),
		};

		const abis = await accountAPI.getTransactionAbis(transaction);
		const serializedTransaction = accountAPI.serializeTransaction(transaction);

		const accountSignature = await accountAPI.signatureProvider.sign({
			chainId: info.chain_id,
			abis,
			requiredKeys: config.privKeys.map(pk => PrivateKey.fromString(pk).getPublicKey().toString()),
			serializedTransaction,
		});

		const pushArgs = { ...accountSignature };
		const result = await accountAPI.pushSignedTransaction(pushArgs);

		console.log(green(result.transaction_id));
	} catch (error) {
		console.log(red(error.message));
	}
}

async function fetchTable(contract, table, scope, bounds, tableIndex, index = 0) {
	if (index >= Configs.WAXEndpoints.length) {
		return [];
	}

	try {
		const endpoint = Configs.WAXEndpoints[index];
		const rpc = new JsonRpc(endpoint, { fetch });

		const data = await Promise.race([
			rpc.get_table_rows({
				json: true,
				code: contract,
				scope: scope,
				table: table,
				lower_bound: bounds,
				upper_bound: bounds,
				index_position: tableIndex,
				key_type: "i64",
				limit: 100,
			}),
			waitFor(5).then(() => null),
		]);

		if (!data) {
			throw new Error();
		}

		return data.rows;
	} catch (error) {
		return await fetchTable(contract, table, scope, bounds, tableIndex, index + 1);
	}
}

async function fetchAccount(account) {
	return await fetchTable("goldmandgame", "miners", "goldmandgame", account, 1);
}

async function fetchAssetData(asset_id, index = 0) {
	if (index >= Configs.atomicEndpoints.length) {
		return [];
	}

	try {
		const cache = path.resolve(os.tmpdir(), "goldmand", `asset_${asset_id}.json`);

		if (await fs.exists(cache)) {
			const json = JSON.parse(await fs.readFile(cache, "utf-8"));
			return json;
		}

		const endpoint = Configs.atomicEndpoints[index];
		const response = await axios.get(`${endpoint}/atomicassets/v1/assets/${asset_id}`, {
			params: {},
			timeout: 5e3,
		});

		if (response.data.data) {
			await fs.mkdir(path.dirname(cache)).catch(() => {});
			await fs.writeFile(cache, JSON.stringify(response.data.data), "utf-8");
		}

		return response.data.data;
	} catch (error) {
		console.log(error.message);
		return await fetchAssetData(asset_id, index + 1);
	}
}

function makeMineAction(account) {
	return {
		account: "goldmandgame",
		name: "mine",
		authorization: [{ actor: account, permission: "active" }],
		data: { miner: account },
	};
}

async function mine(account, privKey) {
	shuffleEndpoints();

	const { DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	logTask(`Mining`);
	console.log(`Fetching account ${cyan(account)}`);
	const [accountInfo] = await fetchAccount(account);

	if (!accountInfo) {
		console.log(`${red("Error")} Account ${cyan(account)} not found`);
		return;
	}

	const land = await fetchAssetData(accountInfo.land);
	const tools = await async.mapSeries(
		accountInfo.inventory.filter(asset_id => !!asset_id),
		async asset_id => await fetchAssetData(asset_id)
	);
	const nextAvailability =
		accountInfo.last_mine + land.data.delay + tools.reduce((agg, t) => agg + parseFloat(t.data.delay), 0);
	const nextClaim = new Date(nextAvailability * 1e3);

	console.log(account, { nextAvailability, nextClaim });
	if (Date.now() <= nextClaim.getTime()) {
		console.log(
			`${yellow("Warning")}`,
			`Mining still in cooldown`,
			yellow(parseRemainingTime(nextClaim.getTime() - Date.now()))
		);
		return;
	}

	const delay = _.round(_.random(delayMin, delayMax, true), 2);

	console.log(`\tMining`, `(after a ${Math.round(delay)}s delay)`);
	const actions = [makeMineAction(account)];

	await waitFor(delay);
	await transact({ account, privKeys: [privKey], actions });
}

async function runTasks(account, privKey) {
	await mine(account, privKey);
	console.log(); // just for clarity
}

async function runAccounts(accounts) {
	for (let i = 0; i < accounts.length; i++) {
		const { account, privKey } = accounts[i];
		await runTasks(account, privKey);
	}
}

(async () => {
	console.log(`Goldmand Bot initialization`);

	const accounts = Object.entries(process.env)
		.map(([k, v]) => {
			if (k.startsWith("ACCOUNT_NAME")) {
				const id = k.replace("ACCOUNT_NAME", "");
				const key = process.env[`PRIVATE_KEY${id}`];
				if (!key) {
					console.log(red(`Account ${v} does not have a PRIVATE_KEY${id} in .env`));
					return;
				}

				try {
					// checking if key is valid
					PrivateKey.fromString(key).toLegacyString();
				} catch (error) {
					console.log(red(`PRIVATE_KEY${id} is not a valid EOS key`));
					return;
				}

				return { account: v, privKey: key };
			}

			return null;
		})
		.filter(acc => !!acc);

	const { CHECK_INTERVAL } = process.env;
	const interval = parseInt(CHECK_INTERVAL) || 15;

	console.log(`Goldmand Bot running for ${accounts.map(acc => cyan(acc.account)).join(", ")}`);
	console.log(`Running every ${interval} minutes`);
	console.log();

	runAccounts(accounts);

	setInterval(() => runAccounts(accounts), interval * 60e3);
})();
