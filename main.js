import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import csv from "csv-parser";
import { get_config_by_path, get_config_path_by_args } from "./src/config.js";

/**
 * Define function to process all sequences from fastq
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
				console.log(`Translated sequences saved to: ${fullFastaPath}`);
				resolve();
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
			console.error(`Failed to write to sample.fasta: ${err.message}`);
			reject(new Error(`Failed to write to sample.fasta: ${err.message}`));
		});
	});
}

/**
 * Define function to run hmmsearch
 * @param {string} modelPath
 * @param {string} fastaPath
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
async function runHMMSearch(modelPath, fastaPath, outputPath) {
	// Return a Promise that wraps the asynchronous execution of hmmsearch
	return new Promise((resolve, reject) => {
		const hmmsearch = spawn("hmmsearch", [
			"-E",
			"1e-5", // e-value threshold
			"--domtblout",
			outputPath, // hmmsearch output is written to specified output file
			modelPath,
			fastaPath,
		]);

		// Log stdout data to console (debugging, can remove later?)
		hmmsearch.stdout.on("data", (data) => {
			console.log(`stdout: ${data}`);
		});

		// Capture and log any error messages generated by hmmsearch
		hmmsearch.stderr.on("data", (data) => {
			console.error(`stderr: ${data}`);
		});

		hmmsearch.on("close", (code) => {
			// Check exit code to determine if hmmsearch was successful
			if (code === 0) {
				console.log(
					`hmmsearch completed successfully. Output written to ${outputPath}`,
				);
				resolve();
			} else {
				// If exit code is non-zero, an error occurred
				reject(new Error(`hmmsearch process exited with code ${code}`));
			}
		});
	});
}

/**
 * Define function to parse full hmmsearch output
 * @param {string} hmmerOut
 * @returns {Promise<Array<{
 * target_name: string,
 * score: number,
 * e_value: number,
 * ali_from: number,
 * ali_to: number}>>}
 */
async function parseFullHMMOutput(hmmerOut) {
	try {
		const lines = (await fs.promises.readFile(hmmerOut, "utf8")).split("\n");
		const parsedData = [];

		// Parse valid entries
		for (const line of lines) {
			if (line.startsWith("#") || line.trim() === "") {
				continue;
			}

			const columns = line.trim().split(/\s+/);
			if (columns.length < 23) {
				continue;
			}

			// Extract relevant columns
			const entry = {
				target_name: columns[0], // Target sequence name
				score: Number.parseFloat(columns[7]), // Bit score
				e_value: Number.parseFloat(columns[6]), // E-value
				ali_from: Number.parseInt(columns[17], 10), // Alignment start
				ali_to: Number.parseInt(columns[18], 10), // Alignment end
			};

			parsedData.push(entry);
		}

		// Group entries by target_name and select the highest scoring row per target
		// Each entry represents a parsed hit (row) from hmmsearch output
		/** @type {Record<string, {target_name: string, score: number, e_value: number, ali_from: number, ali_to: number} >} */
		const bestEntries = {};

		for (const entry of parsedData) {
			const key = entry.target_name;
			const entryForTarget = bestEntries[key];

			// Keep the highest-scoring entry per target_name
			if (entryForTarget === undefined) {
				bestEntries[key] = entry; // if this is the first time encountering this target, save it to bestEntries
			} else if (entryForTarget.score < entry.score) {
				bestEntries[key] = entry; // if this entry of target is greater than the current bestEntries, replace
			}
		}

		return Object.values(bestEntries);
	} catch (error) {
		if (error instanceof Error) {
			console.error(`Error parsing hmmsearch output: ${error.message}`);
		} else {
			console.error("Unknown error occurred.");
		}
		throw error;
	}
}

/**
 * Define function to parse FASTA file and store sequences by target_name
 * @param {string} fastaFilePath
 * @returns {Promise<Object<string, string>>}
 */
async function parseFasta(fastaFilePath) {
	try {
		const data = await fs.promises.readFile(fastaFilePath, "utf8");
		const lines = data.trim().split("\n");
		/** @type {Record<string, string>} */
		const sequences = {};
		let targetName = "";
		let sequence = "";

		for (const line of lines) {
			if (line.startsWith(">")) {
				if (targetName) {
					sequences[targetName] = sequence; // Save last sequence
				}
				targetName = line.substring(1).split(" ")[0]; // Remove ">" and extra info
				sequence = "";
			} else {
				sequence += line.trim();
			}
		}

		if (targetName) {
			sequences[targetName] = sequence; // Save last entry
		}

		return sequences;
	} catch (error) {
		if (error instanceof Error) {
			console.error(`Error parsing FASTA file: ${error.message}`);
		} else {
			console.error("Unknown error occurred.");
		}
		throw error;
	}
}

/**
 * Define function to merge HMMER output and fasta sequences by target_name
 * @param {string} hmmerFilePath
 * @param {string} fastaFilePath
 * @param {string} fastqFilePath
 * @param {string} hmmFilePath
 * @returns {Promise<Array<{
 * target_name: string,
 * score: number,
 * e_value: number,
 * ali_from: number,
 * ali_to: number,
 * sequence: string,
 * FASTQ_filename: string,
 * model_name: string,
 * trimmed_seq: string,
 * seq_len: number,
 * start_pos: number}>>}
 */
async function mergeData(
	hmmerFilePath,
	fastaFilePath,
	fastqFilePath,
	hmmFilePath,
) {
	// Parse HMMER output and FASTA file
	const [hmmerData, fastaData] = await Promise.all([
		parseFullHMMOutput(hmmerFilePath),
		parseFasta(fastaFilePath),
	]);

	// Extract filenames from paths
	const fastqFilename = fastqFilePath.split("/").pop() || "";
	const modelName = hmmFilePath.split("/").pop() || "";

	// Create array
	const mergedData = [];

	for (const entry of hmmerData) {
		const fullSequence = fastaData[entry.target_name]; // Extract full sequence for target_name from the fasta file
		const trimmedSeq = fullSequence.slice(entry.ali_from - 1, entry.ali_to); // Trim sequence
		const seqLen = trimmedSeq.length; // Calculate trimmed sequence length

		// Extract start position from target_name
		const match = entry.target_name.match(/frame=(-?\d+)/);
		const startPos = match ? Number.parseInt(match[1], 10) : 0; // if no match is found, startPos is set to 0

		// Remove "frame=" information from target_name
		const cleanedTargetName = entry.target_name
			.replace(/_frame=-?\d+/, "")
			.trim();

		mergedData.push({
			...entry,
			target_name: cleanedTargetName,
			sequence: fullSequence, // Attach full FASTA sequence
			FASTQ_filename: fastqFilename,
			model_name: modelName, // HMM filename
			trimmed_seq: trimmedSeq,
			seq_len: seqLen,
			start_pos: startPos, // Start position for translation
		});
	}

	return mergedData;
}

/**
 * Define function to count unique VH-VL pairs
 * @param {string} mergedDataPath
 * @returns {Promise<{ vh_sequence: (string|null), vl_sequence: (string|null), count: number }[]>}
 */
async function countSeqs(mergedDataPath) {
	return new Promise((resolve, reject) => {
		/**
		 * @type {Object.<string, {target_name: string, FASTQ_filename: string, vh_sequence: (string|null), vl_sequence: (string|null)}>}
		 * allSeqPairs: Object to store VH-VL sequence pairs, indexed by the unique key of target_name and FASTQ_filename
		 */
		const allSeqPairs = {}; // Object to store pairs

		fs.createReadStream(mergedDataPath)
			.pipe(csv())
			.on("data", (entry) => {
				const isVH = entry.model_name.toLowerCase().includes("vh");
				const isVL = entry.model_name.toLowerCase().includes("vl");

				if (isVH || isVL) {
					const { target_name, FASTQ_filename, trimmed_seq } = entry; // Extract relevant columns from the entry
					const targetFastqPair = `${target_name}_${FASTQ_filename}`; // define a unique combination of target_name and FASTQ_filename

					// Create a new entry for targetFastqPair if one does not exist already in allSeqPairs
					if (!allSeqPairs[targetFastqPair]) {
						allSeqPairs[targetFastqPair] = {
							target_name,
							FASTQ_filename,
							vh_sequence: null,
							vl_sequence: null,
						};
					}

					// Check if current sequence is a VH sequence
					if (isVH && allSeqPairs[targetFastqPair].vh_sequence === null) {
						// If no VH sequence has been assigned yet, assign the trimmed sequence
						allSeqPairs[targetFastqPair].vh_sequence = trimmed_seq;
						// Check if current sequence is a VH sequence
					} else if (
						isVL &&
						allSeqPairs[targetFastqPair].vl_sequence === null
					) {
						// If no VL sequence has been assigned yet, assign the trimmed sequence
						allSeqPairs[targetFastqPair].vl_sequence = trimmed_seq;
					}
				}
			})
			.on("end", () => {
				// Process and count pairs
				const completePairs = Object.values(allSeqPairs).filter(
					(pair) => pair.vh_sequence && pair.vl_sequence,
				);

				/**
				 * @type {Object.<string, {vh_sequence: (string|null), vl_sequence: (string|null), count: number}>}
				 * pairCounts: Object to store the counts of unique VH-VL sequence pairs
				 */
				const pairCounts = {};
				for (const pair of completePairs) {
					const { vh_sequence, vl_sequence } = pair;
					const sequencePair = `${vh_sequence}_${vl_sequence}`; // define a unique identifier for VH/VL pair

					// Check if sequence pair already exists in pairCounts
					if (!pairCounts[sequencePair]) {
						// If not, initialize entry with VH + VL sequences and a count of 0
						pairCounts[sequencePair] = { vh_sequence, vl_sequence, count: 0 };
					}
					// Increment count for this sequence pair
					pairCounts[sequencePair].count++;
				}

				// Sort counts in descending order
				const result = Object.values(pairCounts).sort(
					(a, b) => b.count - a.count,
				);
				resolve(result);
			})
			.on("error", (error) => reject(error));
	});
}

/**
 * Define function to write/append merged output to CSV
 * @param {string} outputFile
 * @param {Array<Record<string, any>>} data
 * @param {boolean} append
 */
async function writeCsv(outputFile, data, append = false) {
	try {
		const header = Object.keys(data[0]);
		const rows = data.map((row) =>
			header.map((col) => row[col] || "").join(","),
		);
		const csvContent = rows.join("\n");

		// Check if the file exists and append data instead of overwriting
		if (append && fs.existsSync(outputFile)) {
			fs.appendFileSync(outputFile, `\n${csvContent}`, "utf8");
		} else {
			fs.writeFileSync(
				outputFile,
				[header.join(","), csvContent].join("\n"),
				"utf8",
			);
		}

		console.log(`CSV updated: ${outputFile}`);
	} catch (error) {
		if (error instanceof Error) {
			console.error(`Error writing CSV: ${error.message}`);
		} else {
			console.error("Unknown error occurred.");
		}
		throw error;
	}
}

// Define main function
async function main() {
	// Read config
	const config_path = await get_config_path_by_args();
	const config = get_config_by_path(config_path);
	console.log(config);
	if (config === null) {
		return; // exit program if config is null
	}

	// Extract parameters from config object
	const { output_path, min_quality, input_pairs } = config;

	// Define paths for final output files
	const matchesOut = path.join(output_path, "ngs_hmm_matches.csv");
	const countsOut = path.join(output_path, "ngs_trimmed_counts.csv");

	// Loop over input pairs
	for (const { fastq_path, model_path } of input_pairs) {
		console.log(`Processing: ${fastq_path} with model ${model_path}`);

		// Define intermediate output paths (these will be removed when processing is complete!)
		const fullFastaPath = path.join(output_path, "full.fasta");
		const domtbloutPath = path.join(output_path, "hmmsearch_out.tbl");

		try {
			// Translate sequences in all 6 frames
			await fullSeqKit(fastq_path, min_quality, fullFastaPath);

			// Run HMMER on all translated sequences
			await runHMMSearch(model_path, fullFastaPath, domtbloutPath);

			// Merge hmmsearch results with sequence information and trim based on match results
			const mergedData = await mergeData(
				domtbloutPath,
				fullFastaPath,
				fastq_path,
				model_path,
			);
			await writeCsv(matchesOut, mergedData, true);
			console.log("Matches written to:", matchesOut);

			// Clean intermediate files
			fs.unlinkSync(fullFastaPath);
			fs.unlinkSync(domtbloutPath);
		} catch (error) {
			if (error instanceof Error) {
				console.error(error.message);
			} else {
				console.error("Unknown error occurred.");
			}
			throw error;
		}
	}

	// Count unique VH/VL pairs after all input pairs are processed
	try {
		const countData = await countSeqs(matchesOut);
		await writeCsv(countsOut, countData, true);
		console.log("Final counts written to:", countsOut);
	} catch (error) {
		if (error instanceof Error) {
			console.error("Error in countSeqs:", error.message);
		} else {
			console.error("Unknown error occurred.");
		}
		throw error;
	}
}

// Execute main function
main().catch(console.error);
