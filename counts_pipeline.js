import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
	get_config_by_path,
	get_config_path_by_args,
} from "./src/counts_config.js";

/**
 * Define function to batch all sequences from fastq
 * @param {string} fastq_path
 * @param {string} batchFastqDir
 * @returns {Promise<void>}
 */
async function batchSeqKit(fastq_path, batchFastqDir) {
	return new Promise((resolve, reject) => {
		const command = `seqkit split ${fastq_path} -s 500000 -O ${batchFastqDir}`;

		// Execute the seqkit command to split the FASTQ file
		const seqkitSplit = spawn(command, { shell: true });

		// Handle stdout and stderr for logging
		seqkitSplit.stdout.on("data", (data) => {
			console.log(`Output: ${data.toString()}`);
		});

		seqkitSplit.stderr.on("data", (data) => {
			console.error(`${data.toString()}`);
		});

		// Handle process termination
		seqkitSplit.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				console.error(`Process exited with code ${code}`);
				reject(new Error(`Process failed with exit code ${code}`));
			}
		});

		// Handle process errors
		seqkitSplit.on("error", (err) => {
			console.error(`Failed to start process: ${err.message}`);
			reject(new Error(`Failed to start process: ${err.message}`));
		});
	});
}

/**
 * Define function to translate all sequences from fastq
 * @param {string} fastq_path
 * @param {number} min_quality
 * @param {string} fullFastaPath
 * @returns {Promise<void>}
 */
async function fullSeqKit(fastq_path, min_quality, fullFastaPath) {
	return new Promise((resolve, reject) => {
		// Construct full shell command as a single string
		const command = `seqkit seq --min-qual ${min_quality} ${fastq_path} | seqkit translate -f 6 -F > ${fullFastaPath}`;
		const seqkitFull = spawn(command, { shell: true });

		// Handle stdout and stderr for logging
		seqkitFull.stdout.on("data", (data) => {
			console.log(`Output: ${data}`);
		});

		seqkitFull.stderr.on("data", (data) => {
			console.error(`Error: ${data}`);
		});

		// Handle process termination
		seqkitFull.on("close", (code) => {
			if (code === 0) {
				// After the process finishes, check if the output FASTA file is empty
				fs.stat(fullFastaPath, (err, stats) => {
					if (err) {
						console.error(`Error checking file stats: ${err.message}`);
						reject(new Error(`Error checking file stats: ${err.message}`));
						return;
					}

					if (stats.size === 0) {
						// If the file is empty, suggest lowering the min_quality threshold
						reject(
							new Error(
								`No sequences found in fasta file. Try lowering the 'min_quality' threshold!`,
							),
						);
					} else {
						console.log(`Translated sequences saved to: ${fullFastaPath}`);
						resolve();
					}
				});
			} else {
				console.error(`Process exited with code ${code}`);
				reject(new Error(`Process failed with exit code ${code}`));
			}
		});

		// Handle process error
		seqkitFull.on("error", (err) => {
			console.error(`Failed to start process: ${err.message}`);
			reject(new Error(`Failed to start process: ${err.message}`));
		});

		// Handle file stream errors
		fs.createWriteStream(fullFastaPath).on("error", (err) => {
			console.error(`Failed to write to temporary fasta: ${err.message}`);
			reject(new Error(`Failed to write to temporary fasta: ${err.message}`));
		});
	});
}

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
 * @param {number} coverage - Minimum required HMM coverage
 * @param {string} bedFilePath - Path to output the BED file
 * @returns {Promise<void>}
 */
async function extractBestHMMHits(domtblPath, coverage, bedFilePath) {
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
				qlen: Number.parseInt(columns[5], 10), // Model length
				score: Number.parseFloat(columns[13]), // Bit score for each domain
				hmm_from: Number.parseInt(columns[15], 10), // HMM start
				hmm_to: Number.parseInt(columns[16], 10), // HMM end
				ali_from: Number.parseInt(columns[17], 10), // Alignment start
				ali_to: Number.parseInt(columns[18], 10), // Alignment end
			};

			// Skip entries that do not cover at least X% of the hmm
			const hmm_covered = entry.hmm_to - entry.hmm_from + 1;
			if (hmm_covered / entry.qlen < coverage) {
				continue;
			}

			// Group entries by target_name and store the highest-scoring hit
			bestEntries.set(entry.target_name, entry);
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
 * Define function to map target names to sequences
 * @param {string} trimmedFastaPath - Path to the FASTA file
 * @param {string} modelName - Model name
 * @param {string} fastqName - Fastq name
 * @param {Map<string, { model: string; sequence: string }[]>} seqMap - Existing map to append sequences
 * @returns {Promise<Map<string, { model: string; sequence: string }[]>>} - Updated sequence map
 */
async function mapFastaSeqs(
	trimmedFastaPath,
	modelName,
	fastqName,
	seqMap = new Map(),
) {
	return new Promise((resolve, reject) => {
		/** @type {string | null} */
		let target_name = null;
		let currentSequence = "";

		const stream = readline.createInterface({
			input: fs.createReadStream(trimmedFastaPath),
			output: process.stdout,
			terminal: false,
		});

		stream.on("line", (line) => {
			if (line.startsWith(">")) {
				if (target_name && currentSequence) {
					// If 'target_name' is not found in the Map assign an empty array
					const sequences = seqMap.get(target_name) ?? [];
					// Append sequence for the current model and target
					sequences.push({
						model: modelName,
						sequence: currentSequence.trim(),
					});
					seqMap.set(target_name, sequences); // Save it back to map
				}

				// Extract target name before "_frame"
				target_name = line.replace(/^>(.*?)_frame.*/, "$1").trim();
				// Append the FASTQ file name to make it unique
				target_name = `${target_name}|${fastqName}`;
				currentSequence = ""; // Reset sequence for new target
			} else {
				currentSequence += line.trim(); // Append sequence data
			}
		});

		stream.on("close", () => {
			if (target_name && currentSequence) {
				const sequences = seqMap.get(target_name) ?? [];
				// Save the last sequence for the current target
				sequences.push({ model: modelName, sequence: currentSequence.trim() });
				seqMap.set(target_name, sequences);
			}
			console.log(`Finished processing. Current seqMap size: ${seqMap.size}`);
			resolve(seqMap);
		});

		stream.on("error", (err) => reject(err));
	});
}

/**
 * Define function to count occurrences of unique sequence combinations
 * @param {Map<string, { model: string, sequence: string }[]>} seqMap
 * @returns {Promise<Array<{ [key: string]: string | number }>>}
 */
async function countSeqs(seqMap) {
	try {
		const allModels = new Set();
		const targetSequences = new Map();

		// Collect sequences per trimmed target name
		for (const [target_name, entries] of seqMap) {
			const trimmedTargetName = target_name.replace(/\|.*$/, "");

			if (!targetSequences.has(trimmedTargetName)) {
				targetSequences.set(trimmedTargetName, []);
			}

			// Store each frame's sequences as a new entry for this target
			const modelSequences = new Map();

			// Track missing models for this target
			const missingModels = new Set(allModels);

			for (const { model, sequence } of entries) {
				// Store sequence by model
				modelSequences.set(model, sequence);
				allModels.add(model); // Add model to allModels set

				// Remove model from missingModels since it's found
				missingModels.delete(model);
			}

			// If there are any missing models for this target, skip it
			if (missingModels.size > 0) {
				continue;
			}

			// Store valid model sequences for this target
			targetSequences.get(trimmedTargetName).push(modelSequences);
		}

		// Convert Set to an array for consistent ordering of models
		const allModelNames = Array.from(allModels);

		const seqCounts = new Map();
		let totalCount = 0; // Initialize total count

		// Count unique sequence combinations across all targets
		for (const sequenceLists of targetSequences.values()) {
			for (const sequences of sequenceLists) {
				// Create a unique key for each sequence combination
				const seqKey = allModelNames
					.map((model) => `${model}:${sequences.get(model)}`)
					.join("|");

				if (!seqCounts.has(seqKey)) {
					seqCounts.set(seqKey, {
						sequences: Object.fromEntries(sequences),
						count: 0,
					});
				}

				seqCounts.get(seqKey).count++;
			}
		}

		totalCount = Array.from(seqCounts.values()).reduce(
			(sum, entry) => sum + entry.count,
			0,
		);

		// Convert results to sorted array
		return Array.from(seqCounts.values())
			.sort((a, b) => b.count - a.count)
			.map(({ sequences, count }) => ({
				...Object.fromEntries(
					Object.entries(sequences).map(([model, seq]) => [
						`${model.replace(/\.[^.]+$/, "")}`, // Remove file extension
						seq,
					]),
				),
				Count: count,
				Total_Count: totalCount,
				Frequency: count / totalCount,
			}));
	} catch (error) {
		console.error("Error processing sequence counts:", error);
		throw error;
	}
}

/**
 * Write data to a CSV file
 * @param {Array<{[key: string]: string | number}>} data
 * @param {string} outputPath
 */
function writeCSV(data, outputPath) {
	if (data.length === 0) {
		console.log("No data to write.");
		return;
	}

	// Collect all unique headers across data entries
	const allHeaders = new Set();
	for (const row of data) {
		for (const key of Object.keys(row)) {
			allHeaders.add(key);
		}
	}
	const headers = Array.from(allHeaders);

	// Convert data to CSV format
	const csvRows = [
		headers.join(","), // Header row
		...data.map(
			(row) => headers.map((col) => row[col] || "NA").join(","), // Data rows
		),
	];

	// Write CSV to file
	fs.writeFileSync(outputPath, csvRows.join("\n"), "utf8");
}

async function main() {
	// Read config
	const config_path = await get_config_path_by_args();
	const config = get_config_by_path(config_path);
	console.log(config);
	if (config === null) {
		return; // exit program if config is null
	}

	// Extract parameters from config object
	const { counts_outpath, min_quality, hmm_coverage, input_pairs } = config;

	// Create temporary directory to store intermediate output
	const mainTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "main-"));
	const batchTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-")); // base directory to store split fastq files

	// Create a map to store the split FASTQ paths and their corresponding model paths
	const split_input_pairs = new Map();

	// Split all FASTQ files
	for (const { fastq_path, model_path } of input_pairs) {
		// Extract filename without extension for unique directory
		const fastqBaseName = path.basename(fastq_path, path.extname(fastq_path));
		const modelName = path.basename(model_path, path.extname(model_path));

		// Define a unique subdirectory inside batchTempDir
		const fastqOutputDir = path.join(batchTempDir, fastqBaseName, modelName);

		// Ensure batchSeqKit uses a unique directory for each FASTQ file
		await batchSeqKit(fastq_path, fastqOutputDir);

		// Read the split files inside the output directory
		const splitFiles = fs
			.readdirSync(fastqOutputDir)
			.filter((f) => f.endsWith(".fastq.gz") || f.endsWith(".fastq")) // Allow both zipped and unzipped FASTQ files
			.map((f) => path.join(fastqOutputDir, f)); // Get full paths

		if (splitFiles.length === 0) {
			throw new Error(`No FASTQ files found in ${fastqOutputDir}`);
		}

		// Store each split file separately with the corresponding model
		for (const file of splitFiles) {
			split_input_pairs.set(file, model_path);
		}
	}

	// Initialize empty map for sequences
	/** @type {Map<string, { model: string; sequence: string }[]>} */
	let seqMap = new Map();

	for (const [split_fastq_path, model_path] of split_input_pairs) {
		// Extract file names
		const fastqName = path.basename(
			split_fastq_path,
			path.extname(split_fastq_path),
		);
		const modelName = path.basename(model_path, path.extname(model_path));
		console.log(`Processing: ${fastqName} with model ${modelName}`);

		// Define intermediate file paths
		const translatedFastaPath = path.join(
			mainTempDir,
			`${fastqName}_${modelName}_translated.fasta`,
		);
		const domtblPath = path.join(
			mainTempDir,
			`${fastqName}_${modelName}.domtblout`,
		);
		const stdoutPath = path.join(
			mainTempDir,
			`${fastqName}_${modelName}.stdout`,
		);
		const bedOut = path.join(
			mainTempDir,
			`${fastqName}_${modelName}_output.bed`,
		);
		const trimmedFasta = path.join(
			mainTempDir,
			`${fastqName}_${modelName}_trimmed.fasta`,
		);

		// Translate in all 6 reading frames
		console.log(`Translating: ${fastqName}...`);
		await fullSeqKit(split_fastq_path, min_quality, translatedFastaPath);

		// Run HMMER on all translated sequences
		console.log(
			`Running hmmsearch for: ${translatedFastaPath} with model ${modelName}...`,
		);
		await runHMMSearch(model_path, translatedFastaPath, domtblPath, stdoutPath);

		// Generate BED file of best hits and their alignment coordinates
		console.log(
			`Mapping trimmed sequences to target names for: ${trimmedFasta}...`,
		);
		await extractBestHMMHits(domtblPath, hmm_coverage, bedOut);

		// Trim sequences based on alignment coordinates
		await trimSeqs(translatedFastaPath, bedOut, trimmedFasta);
		seqMap = await mapFastaSeqs(trimmedFasta, modelName, fastqName, seqMap); // Update seqMap with each FASTA file
	}

	// Once all sequences have been added to seqMap, count the sequences
	console.log("Generating count file...");
	const seqCounts = await countSeqs(seqMap);
	await writeCSV(seqCounts, counts_outpath);

	// Remove temporary directories and all contents
	console.log("Cleaning up temporary files...");
	fs.rmSync(mainTempDir, { recursive: true, force: true });
	fs.rmSync(batchTempDir, { recursive: true, force: true });
	console.log(`Pipeline completed! Counts saved to: ${counts_outpath}`);

	return seqCounts;
}

// Execute main function
main().catch(console.error);