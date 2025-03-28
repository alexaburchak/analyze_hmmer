import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import csv from "csv-parser";
import {
	get_config_by_path,
	get_config_path_by_args,
} from "./src/match_config.js";

/**
 * Define function to run hmmsearch
 * @param {string} modelPath
 * @param {string} fastaPath
 * @param {string} domtblPath
 * @param {string} stdoutPath
 * @returns {Promise<void>}
 */
async function runHMMSearch(modelPath, fastaPath, domtblPath, stdoutPath) {
	return new Promise((resolve, reject) => {
		const hmmsearch = spawn("hmmsearch", [
			"-E",
			"1e-5", // e-value threshold
			"--domtblout",
			domtblPath,
			modelPath,
			fastaPath,
		]);

		// Create stream for the stdout file
		const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "a" });

		// Capture and write any data from stdout to the file
		hmmsearch.stdout.on("data", (data) => {
			stdoutStream.write(data);
		});

		// Capture and log any error messages generated by hmmsearch
		hmmsearch.stderr.on("data", (data) => {
			console.error(`stderr: ${data}`);
		});

		hmmsearch.on("close", (code) => {
			// Check exit code to determine if hmmsearch was successful
			if (code === 0) {
				stdoutStream.end(); // Close the stdout file stream
				resolve();
			} else {
				// If exit code is non-zero, an error occurred
				reject(new Error(`hmmsearch process exited with code ${code}`));
			}
		});
	});
}

/**
 * Define function to parse full hmmsearch output, determine best hit per target and generate a BED file
 * @param {string} domtblPath - Path to the hmmsearch domtblout file
 * @param {string} bedFilePath - Path to output the BED file
 * @returns {Promise<void>}
 */
async function extractBestHMMHits(domtblPath, bedFilePath) {
	try {
		// Create readable stream for hmmer output
		const fileStream = fs.createReadStream(domtblPath, "utf8");

		// Create readline interface to read the file line by line
		const rl = readline.createInterface({
			input: fileStream,
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		/** @type {Map<string, { target_name: string, score: number, ali_from: number, ali_to: number }>} */
		const bestEntries = new Map(); // Initialize map to store highest-scoring hmmsearch hit for each target sequence

		// Parse valid entries
		for await (const line of rl) {
			if (line.startsWith("#") || line.trim() === "") {
				continue; // Skip comment/empty lines
			}

			const columns = line.trim().split(/\s+/);
			if (columns.length < 23) {
				continue; // Skip lines that don't have enough columns
			}

			// Extract relevant columns
			const entry = {
				target_name: columns[0], // Target sequence name
				score: Number.parseFloat(columns[7]), // Bit score
				ali_from: Number.parseInt(columns[17], 10), // Alignment start
				ali_to: Number.parseInt(columns[18], 10), // Alignment end
			};

			// Group entries by target_name and store the highest-scoring hit
			const key = entry.target_name.split("_frame=")[0]; // Strip out frame info for unique target name
			const entryForTarget = bestEntries.get(key);

			if (entryForTarget === undefined || entryForTarget.score < entry.score) {
				bestEntries.set(key, entry); // If this is the highest score, update it
			}
		}

		// Generate the BED file content
		/** @type {string[]} bedContent - An array of strings, where each string represents a line in the BED file */
		const bedContent = [];
		for (const entry of bestEntries.values()) {
			// Format the BED file line
			const bedLine = [
				entry.target_name, // Target name
				entry.ali_from - 1, // Start position (BED format is 0-based)
				entry.ali_to, // End position
				entry.score, // Bit score
			].join("\t");
			bedContent.push(bedLine);
		}

		// Write the BED content to a file
		fs.writeFileSync(bedFilePath, bedContent.join("\n"));
	} catch (error) {
		if (error instanceof Error) {
			console.error(error.message);
		} else {
			console.error("Unknown error occurred.");
		}
		throw error;
	}
}

/**
 * Define function to trim sequences based on coordinates from HMMER
 * @param {string} inFastaFilePath - Path to input fasta file (raw protein sequences)
 * @param {string} bedFilePath - Path to BED file with trimming coordinates from each HMMER hit
 * @param {string} outFastaFilePath
 * @returns {Promise<string>}
 */
async function trimSeqs(inFastaFilePath, bedFilePath, outFastaFilePath) {
	return new Promise((resolve, reject) => {
		const command = `seqkit subseq --bed ${bedFilePath} ${inFastaFilePath} > ${outFastaFilePath}`;
		const seqkitSubseq = spawn(command, { shell: true });

		let output = "";
		let errorOutput = "";

		// Capture data from stdout stream (trimmed seqs)
		seqkitSubseq.stdout.on("data", (data) => {
			output += data.toString();
		});

		seqkitSubseq.stderr.on("data", (data) => {
			errorOutput += data.toString();
		});

		seqkitSubseq.on("close", (code) => {
			if (code === 0) {
				resolve(output);
			} else {
				console.error(
					`seqkit subseq failed with exit code ${code}: ${errorOutput}`,
				);
				reject(
					new Error(`Command failed with exit code ${code}: ${errorOutput}`),
				);
			}
		});

		seqkitSubseq.on("error", (err) => {
			console.error("Failed to start seqkit process:", err.message);
		});
	});
}

/**
 * Function to read FASTA file and extract query sequences
 * @param {string} fastaFile - Path to the FASTA file
 * @returns {Promise<string[]>} Array of protein sequences
 */
function readFastaFile(fastaFile) {
	return new Promise((resolve, reject) => {
		fs.readFile(fastaFile, "utf8", (err, data) => {
			if (err) {
				return reject(err);
			}

			const sequences = data
				.split(">")
				.slice(1) // Remove empty split before first '>'
				.map((entry) => entry.split("\n").slice(1).join("")) // Remove header lines
				.filter((seq) => seq.trim().length > 0);

			resolve(sequences);
		});
	});
}

/**
 * Function to compute Levenshtein distance between two sequences
 * @param {string} a first protein sequence
 * @param {string} b second protein sequence
 * @returns {number} levenshtein distance between sequence a and sequence b
 */
function levenshteinDistance(a, b) {
	// Create 2D array
	const dp = Array(a.length + 1)
		.fill(null)
		.map(() => Array(b.length + 1).fill(null));

	// Initialize the first column
	for (let i = 0; i <= a.length; i++) {
		dp[i][0] = i;
	}

	// Initialize the first row
	for (let j = 0; j <= b.length; j++) {
		dp[0][j] = j;
	}

	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			// Determine if amino acids are the same (cost 0) or different (cost 1)
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;

			// if different, take the minimum
			dp[i][j] = Math.min(
				dp[i - 1][j] + 1, // deletion
				dp[i][j - 1] + 1, // insertion
				dp[i - 1][j - 1] + cost, // substitution
			);
		}
	}
	return dp[a.length][b.length];
}

/**
 * Reads a CSV file and searches for the closest matching protein sequences
 * @param {string} csvFile - CSV file path
 * @param {{original: string[], trimmed: string[]}} queries - Array of original and trimmed query sequences from FASTA file
 * @param {string} sequenceColumn - The name of the column containing protein sequences
 * @param {number} [maxLevenshteinDistance=Infinity] - Optional filter on Levenshtein distance
 * @returns {Promise<Map<string, Array<Object>>>} - A map with trimmed query sequences as keys and its corresponding matches as the value
 */
async function findClosestMatches(
	csvFile,
	queries,
	sequenceColumn,
	maxLevenshteinDistance = Number.POSITIVE_INFINITY,
) {
	/** @type {Array<Record<string, string>>} */
	const records = [];

	return new Promise((resolve, reject) => {
		fs.createReadStream(csvFile)
			.pipe(csv())
			.on("data", (row) => {
				if (row && typeof row === "object") {
					// Ensure the row contains sequenceColumn
					if (sequenceColumn in row) {
						records.push(row);
					} else {
						console.warn(
							`Skipping row in ${csvFile}: Missing column "${sequenceColumn}"`,
						);
					}
				}
			})
			.on("end", () => {
				const matchesMap = new Map();

				for (const querySequence of queries.trimmed) {
					const originalQuery = queries.original[queries.trimmed.indexOf(querySequence)];
					console.log(`Searching for matches to query: ${querySequence}`);

					const matches = records
						.map((row) => {
							const sequence = row[sequenceColumn];

							if (!sequence) {
								return null;
							} // Skip empty sequences

							const dist = levenshteinDistance(querySequence, sequence);

							if (dist <= maxLevenshteinDistance) {
								return {
									Original_Query_Seq: originalQuery,
									Trimmed_Query_Seq: querySequence,
									Matched_Seq: sequence,
									Levenshtein_Dist: dist,
									Count: Number(row.Count),
									Total_Count: Number(row.Total_Count),
									Frequency: Number(row.Frequency)
								};
							}
							return null;
						})
						.filter(Boolean);

					// Sort by levenshtein distance
					matches.sort((a, b) => {
						if (a === null || b === null) {
							throw new Error(
								"Unexpected null value encountered during sorting.",
							);
						}
						return a.Levenshtein_Dist - b.Levenshtein_Dist;
					});
					matchesMap.set(querySequence, matches);
				}

				resolve(matchesMap);
			})
			.on("error", reject);
	});
}

/**
 * Function to write data to a CSV file
 * @param {Map<string, Array<Record<string, any>>>} data
 * @param {string} outputPath
 */
function writeCSV(data, outputPath) {
	if (data.size === 0) {
		console.log("No data to write.");
		return;
	}

	// Collect all unique headers across all objects in the map
	const allHeaders = new Set();
	for (const [, rows] of data) {
		for (const row of rows) {
			for (const key of Object.keys(row)) {
				allHeaders.add(key);
			}
		}
	}

	const headers = Array.from(allHeaders);

	// Convert map data to CSV format
	const csvRows = [
		headers.join(","), // Header row
	];

	// Flatten the rows and create CSV data
	for (const [, rows] of data) {
		for (const row of rows) {
			csvRows.push(
				headers
					.map((col) => (row[col] === undefined ? "NA" : row[col]))
					.join(","),
			);
		}
	}

	// Write CSV to file
	fs.writeFileSync(outputPath, csvRows.join("\n"), "utf8");
}

// Main logic
async function main() {
	// Read config
	const config_path = await get_config_path_by_args();
	const config = get_config_by_path(config_path);
	console.log(config);
	if (config === null) {
		return; // exit program if config is null
	}

	// Extract parameters from config object
	const { max_LD, input_list } = config;

	// Define temporary variables
	const mainTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "main-"));
	const domtblPath = path.join(mainTempDir, "query_domtblout.tbl");
	const stdoutPath = path.join(mainTempDir, "query_domstdout.txt");
	const bedFilePath = path.join(mainTempDir, "query_output.bed");
	const outFastaFilePath = path.join(mainTempDir, "trimmed_query_seqs.fasta");

	for (const { query_path, model_path, csv_path, output_path } of input_list) {
		let queryPath;
		let originalQueries = []; //keep track of untrimmed query sequences 
		if (!query_path.endsWith(".fasta")) {
			// If the query does NOT end with .fasta, treat it as a sequence string
			const fastaFile = path.join(__dirname, "temp_query.fasta");
			const fastaContent = `>query\n${query_path}\n`; // Format the sequence as a FASTA entry
			fs.writeFileSync(fastaFile, fastaContent); // Write it to a temporary FASTA file
			queryPath = fastaFile;
			originalQueries = [query_path]; 
		} else {
			// If it's already a FASTA file, pass it directly
			queryPath = query_path;
			originalQueries = await readFastaFile(query_path); // Read original queries from FASTA file
		}

		// Process raw query sequences (hmmsearch + sequence trimming)
		await runHMMSearch(model_path, queryPath, domtblPath, stdoutPath);
		await extractBestHMMHits(domtblPath, bedFilePath);
		await trimSeqs(queryPath, bedFilePath, outFastaFilePath);

		// Extract sequenceColumn name from model_path
		const sequenceColumn = path.basename(model_path, path.extname(model_path));

		// Extract trimmed reads and assign to original queries 
		const trimmedQueries = await readFastaFile(outFastaFilePath);
		const queries = {
			original: originalQueries,
			trimmed: trimmedQueries
		};

		// Generate map of closest matching protein sequences from csv files
		const matchesMap = await findClosestMatches(
			csv_path,
			queries,
			sequenceColumn,
			max_LD,
		);

		// Write map to CSV
		writeCSV(matchesMap, output_path);
		console.log("CSV of sequence matches saved to:", output_path);
	}

	// Remove temporary files
	console.log("Cleaning up temporary files...");
	fs.rmSync(mainTempDir, { recursive: true, force: true });
	console.log("Matching pipeline complete!");
}

// Execute main function
main().catch(console.error);