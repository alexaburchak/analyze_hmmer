import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { get_config_by_path, get_config_path_by_args } from "./src/config.js";

// Define function to process ALL sequences from fastq
// @ts-ignore
async function fullSeqKit(fastq_path, min_quality, output_dir, fullFastaPath) {
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
				resolve(fullFastaPath);
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

// Define function to run hmmsearch
// @ts-ignore
async function runHMMSearch(modelPath, fastaPath, outputPath) {
	// Return a Promise that wraps the asynchronous execution of hmmsearch
	return new Promise((resolve, reject) => {
		const hmmsearch = spawn("hmmsearch", [
			"-E",
			1e-5, // e-value threshold
			"--domtblout",
			outputPath,
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
				resolve(
					`hmmsearch completed successfully. Output written to ${outputPath}`,
				);
			} else {
				// If exit code is non-zero, an error occurred
				reject(new Error(`hmmsearch process exited with code ${code}`));
			}
		});
	});
}

// Define function to parse full hmmsearch output
// @ts-ignore
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

		// Group by target_name and select the highest scoring row per target
		const bestEntries = {};

		for (const entry of parsedData) {
			const key = entry.target_name; // Only consider the target name, ignoring reading frames

			// Keep the highest-scoring entry per target_name
			// @ts-ignore
			if (!bestEntries[key] || bestEntries[key].score < entry.score) {
				// @ts-ignore
				bestEntries[key] = entry;
			}
		}

		return Object.values(bestEntries);
	} catch (error) {
		// @ts-ignore
		console.error(`Error parsing hmmsearch output: ${error.message}`);
		throw error;
	}
}

// Define function to parse FASTA file and store sequences by target_name
// @ts-ignore
async function parseFasta(fastaFilePath) {
	try {
		const data = await fs.promises.readFile(fastaFilePath, "utf8");
		const lines = data.trim().split("\n");
		const sequences = {};
		let targetName = "";
		let sequence = "";

		for (const line of lines) {
			if (line.startsWith(">")) {
				// @ts-ignore
				if (targetName) sequences[targetName] = sequence; // Save last sequence
				targetName = line.substring(1).split(" ")[0]; // Remove ">" and extra info
				sequence = "";
			} else {
				sequence += line.trim();
			}
		}
		// @ts-ignore
		if (targetName) sequences[targetName] = sequence; // Save last entry

		return sequences;
	} catch (error) {
		// @ts-ignore
		console.error(`Error parsing FASTA file: ${error.message}`);
		throw error;
	}
}

// Define function to merge HMMER output and fasta sequences by target_name
// @ts-ignore
async function mergeData(
	hmmerFilePath,
	fastaFilePath,
	fastqFilePath,
	hmmFilePath,
) {
	const [hmmerData, fastaData] = await Promise.all([
		parseFullHMMOutput(hmmerFilePath),
		parseFasta(fastaFilePath),
	]);

	// Extract filenames from paths
	const fastqFilename = fastqFilePath.split("/").pop();
	const modelName = hmmFilePath.split("/").pop();

	return (
		hmmerData
			// @ts-ignore
			.filter((entry) => fastaData[entry.target_name]) // Ensure sequence exists
			.map((entry) => {
				// @ts-ignore
				const fullSequence = fastaData[entry.target_name];
				const trimmedSeq = fullSequence.slice(entry.ali_from - 1, entry.ali_to); // Trim sequence
				const seqLen = trimmedSeq.length;

				// Extract start position from target_name
				const match = entry.target_name.match(/frame=(-?\d+)/);
				const startPos = match ? Number.parseInt(match[1], 10) : null;

				// Remove "frame=" information from target_name
				const cleanedTargetName = entry.target_name
					.replace(/_frame=-?\d+/, "")
					.trim();

				return {
					...entry,
					target_name: cleanedTargetName,
					sequence: fullSequence, // Attach full FASTA sequence
					FASTQ_filename: fastqFilename,
					model_name: modelName,
					trimmed_seq: trimmedSeq,
					seq_len: seqLen,
					start_pos: startPos,
				};
			})
	);
}

// Define function to count unique VH-VL pairs
// UNDER CONSTRUCTION

// Define function to write/append merged output to CSV
// @ts-ignore
async function writeCsv(outputFile, data, append = false) {
	try {
		const header = Object.keys(data[0]);
		// @ts-ignore
		const rows = data.map((row) =>
			header.map((col) => row[col] || "").join(","),
		);
		const csvContent = rows.join("\n");

		// Check if the file exists and append data instead of overwriting
		if (append && fs.existsSync(outputFile)) {
			fs.appendFileSync(outputFile, "\n" + csvContent, "utf8");
		} else {
			fs.writeFileSync(
				outputFile,
				[header.join(","), csvContent].join("\n"),
				"utf8",
			);
		}

		console.log(`CSV updated: ${outputFile}`);
	} catch (error) {
		// @ts-ignore
		console.error(`Error writing CSV: ${error.message}`);
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

	// Validate parameters from config
	if (
		!output_path ||
		!min_quality ||
		!Array.isArray(input_pairs) ||
		input_pairs.length === 0
	) {
		console.error("Error: Missing required config values.");
		return;
	}

	// Define paths for final output files
	const date = new Date().toISOString().split("T")[0]; // Record date of job (YYYY-MM-DD)
	const matchesOut = path.join(
		output_path,
		`ngs_hmm_matches_${date}.csv`, // need to add job ID to filename
	);

	// Loop over input pairs
	for (const { fastq_path, model_path } of input_pairs) {
		// Validate parameters
		if (!fastq_path || !model_path) {
			console.error("Error: Missing fastq_path or model_path in input pair.");
			continue; // Skip this pair and move to the next
		}

		console.log(`Processing: ${fastq_path} with model ${model_path}`);

		// Define intermediate output paths (these will be removed when processing is complete!)
		const fullFastaPath = path.join(output_path, "full.fasta");
		const domtbloutPath = path.join(output_path, `hmmsearch_out.tbl`);

		try {
			// Translate sequences in all 6 frames
			await fullSeqKit(fastq_path, min_quality, output_path, fullFastaPath);

			// Run HMMER
			await runHMMSearch(model_path, fullFastaPath, domtbloutPath);

			// Merge hmmsearch results with sequence information and trim based on match results
			const mergedData = await mergeData(
				domtbloutPath,
				fullFastaPath,
				fastq_path,
				model_path,
			);
			await writeCsv(matchesOut, mergedData, true);

			// Clean intermediate files
			fs.unlinkSync(fullFastaPath);
			fs.unlinkSync(domtbloutPath);
		} catch (error) {
			// @ts-ignore
			console.error(error.message);
		}
	}
}

// Execute main function
main().catch(console.error);