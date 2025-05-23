#!/bin/bash

# Extract config arguments
fastq_dir=$1
output_base_dir=$2
pipeline_mode=$3
gzip_compression_level=$4
hmm_file=$5
min_quality=$6
best_start_position=$7

# # Function to load configuration from provided JSON file
# load_config() {
#     local config_file=$1

#     if [ ! -f "$config_file" ]; then
#         echo "Error: Configuration file $config_file not found."
#         exit 1
#     fi

#     echo "Loading configuration from $config_file..."
#     CONFIG_FILE="$config_file"
# }

# # Function to parse configuration values
# get_config_value() {
#     local key=$1
#     jq -r ".$key" "$CONFIG_FILE"
# }

# # Check if a configuration file was provided as an argument
# if [ $# -lt 1 ]; then
#     echo "Usage: $0 <config_file>"
#     exit 1
# fi

# # Load the provided configuration file
# load_config "$1"

# # Load Config Values
# fastq_dir=$(get_config_value "fastq_dir")
# output_base_dir=$(get_config_value "output_base_dir")
# pipeline_mode=$(get_config_value "pipeline_mode")
# hmm_file=$(get_config_value "hmm_file")
# min_quality=$(get_config_value "min_quality")
# best_start_position=$(get_config_value "best_start_position")
# gzip_compression_level=$(get_config_value "gzip_compression_level")

# # Defaults for optional parameters
# best_start_position=${best_start_position:-"auto"}  # Default to "auto" if not provided
# gzip_compression_level=${gzip_compression_level:-6}  # Default to compression level 6 if not provided

# Helper Functions
log() {
    echo "$(date +"%Y-%m-%d %H:%M:%S") [INFO]: $*" | tee -a pipeline.log
}

create_directories() {
    local base_output_dir=$1
    mkdir -p "$base_output_dir/filtered_reads/DNA" \
             "$base_output_dir/filtered_reads/AA" \
             "$base_output_dir/counts" \
             "$base_output_dir/hmmerout" \
             "$base_output_dir/trimmed_reads" \
             "$base_output_dir/trim_tables" 
}

unzip_fastq_files() {
    local fastq_dir=$1
    log "Unzipping FASTQ files in $fastq_dir..."
    for fastq_file in "$fastq_dir"/*.fastq.gz; do
        if [ -f "$fastq_file" ]; then
            pigz -d "$fastq_file"
        fi
    done
}

# Function to determine best frame for translation 
best_frame() {
    local fastq_dir=$1
    local hmm=$2
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local output_dir
    output_dir="$HOME/Desktop/pipeline_output/det_frame"

    # Create output directory
    mkdir -p "$output_dir/filtered_reads" "$output_dir/hmmerout"

    # Translate in all reading frames
    local counter=1
    local sample_AA_reads="$output_dir/filtered_reads"

    for file in "$fastq_dir"/*.fastq; do
        if [ -f "$file" ]; then
            local base_name=$(basename "${file}" .fastq)
            local sample_fastq="filtered_${base_name}.fastq"
            local sample_DNA_reads="${base_name}.fasta"

            log "Filtering $file to $sample_fastq..."
            #seqkit seq --min-qual "$min_quality" "$file" -o "$sample_fastq"
            seqkit fq2fa "$sample_fastq" -o "$sample_DNA_reads"

            log "Translating $sample_DNA_reads to AA sequences..."
            Rscript "$script_dir/Rscripts/translate_sample.R" "$sample_DNA_reads" "$sample_AA_reads" "$counter"

            rm "$sample_fastq" "$sample_DNA_reads"

            counter=$((counter + 1))
        fi
    done

    # Run HMMER on sample files
    for file in "$sample_AA_reads"/*.fasta; do
        local base_name=$(basename "$file" .fasta)
        local hmmerfile="$output_dir/hmmerout/${base_name}.tbl"

        log "Running hmmsearch on $file..."
        hmmsearch --domtblout "$hmmerfile" "$hmm" "$file" > /dev/null 2>&1

        pigz -6 "$file"
    done

    # Determine best translation frame based on e-values 
    log "Determining the best start position for translation..."
    Rscript "$script_dir/Rscripts/determine_frame.R" "$output_dir/hmmerout"

    # Remove intermediate output
    rm -r "$output_dir"
}

# Main AA pipeline 
aa_pipeline() {
    unzip_fastq_files "$fastq_dir"
    create_directories "$output_base_dir"

    if [[ "$best_start_position" == "auto" ]]; then
        # Read best_start_pos from CSV file
        best_frame "$fastq_dir" "$hmm_file"
        best_start_pos_file="$HOME/Desktop/best_start_pos.csv"
        if [[ ! -f "$best_start_pos_file" ]]; then
            log "Error: $best_start_pos_file not found."
            exit 1
        fi
    else
        # If the user provides a start position, use this instead 
        best_start_pos=$best_start_position
    fi

    # Translate all sequences 
    for file in "$fastq_dir"/*.fastq; do
        if [ -f "$file" ]; then
            local base_name=$(basename "${file}" .fastq)
            local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
            local filtered_fastq="filtered_${base_name}.fastq"
            local DNA_reads="$output_base_dir/filtered_reads/DNA/${base_name}.fasta"
            local count_file_fwd="$output_base_dir/counts/${base_name}_fwd_counts.csv"
            local count_file_rev="$output_base_dir/counts/${base_name}_rev_counts.csv"

            log "Filtering $file..."
            seqkit seq --min-qual "$min_quality" "$file" -o "$filtered_fastq"

            log "Converting $filtered_fastq to FASTA..."
            seqkit fq2fa "$filtered_fastq" -o "$DNA_reads"

            log "Translating $DNA_reads to AA sequences..."
            Rscript "$script_dir/Rscripts/alligator_translate.R" "$DNA_reads" "$count_file_fwd" "$count_file_rev" "$output_base_dir/filtered_reads/AA" "$best_start_pos_file"

            pigz -6 "$file" "$DNA_reads"
            rm "$filtered_fastq"
        fi
    done

    #rm "$best_start_pos_file" 

    # Run HMMER and trim sequences 
    log "Running HMMER searches..."
    for file in "$output_base_dir/filtered_reads/AA"/*.fasta; do
        local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        local base_name=$(basename "$file" _AA.fasta)
        local hmmerfile="$output_base_dir/hmmerout/${base_name}_AA_hmmerout.tbl"
        local count_file="$output_base_dir/counts/${base_name}_counts.csv"
        local trim_tables="$output_base_dir/trim_tables/${base_name}.csv"
        local trimmed_reads="$output_base_dir/trimmed_reads/${base_name}.fasta"

        log "Running hmmsearch for $file..."
        hmmsearch --domtblout "$hmmerfile" "$hmm_file" "$file"

        log "Trimming sequences for $file..."
        Rscript "$script_dir/Rscripts/alligator_trim.R" "$hmmerfile" "$count_file" "$trim_tables" "$trimmed_reads"

        pigz -6 "$file" "$hmmerfile"
    done

    # Remove intermediate output
    #rm -r "$output_base_dir/hmmerout" "$output_base_dir/filtered_reads" "$output_base_dir/counts"
}

dna_pipeline() {
    unzip_fastq_files "$fastq_dir"
    create_directories "$output_base_dir"

    for file in "$fastq_dir"/*.fastq; do
        if [ -f "$file" ]; then
            local base_name=$(basename "${file}" .fastq)
            local filtered_fastq="filtered_${base_name}.fastq"
            local DNA_reads="$output_base_dir/filtered_reads/DNA/${base_name}.fasta"

            log "Filtering $file..."
            seqkit seq --min-qual "$min_quality" "$file" -o "$filtered_fastq"

            log "Converting $filtered_fastq to FASTA..."
            seqkit fq2fa "$filtered_fastq" -o "$DNA_reads"

            pigz -6 "$file"
            rm "$filtered_fastq"
        fi
    done

    log "Running HMMER searches..."
    for file in "$output_base_dir/filtered_reads/DNA"/*.fasta; do
        local base_name=$(basename "$file" .fasta)
        local hmmerfile="$output_base_dir/hmmerout/${base_name}_hmmerout.tbl"
        local trim_tables="$output_base_dir/trim_tables/${base_name}.csv"
        local trimmed_reads="$output_base_dir/trimmed_reads/${base_name}.fasta"

        log "Running nhmmer for $file..."
        nhmmer --tblout "$hmmerfile" "$hmm_file" "$file"

        log "Trimming sequences for $file..."
        Rscript "$HOME/Desktop/RScripts/alligator_trim.R" "$hmmerfile" "$file" "$trim_tables" "$trimmed_reads"

        pigz -6 "$file" "$hmmerfile"
    done

    # Remove intermediate output
    rm -r "$output_base_dir/hmmerout" "$output_base_dir/filtered_reads" "$output_base_dir/counts"
}

# Main Logic
if [[ "$pipeline_mode" == "aa" ]]; then
    log "Starting Protein Pipeline..."
    aa_pipeline
elif [[ "$pipeline_mode" == "dna" ]]; then
    log "Starting DNA Pipeline..."
    dna_pipeline
else
    log "Error: Invalid pipeline_mode '$pipeline_mode'. Please set to 'aa' or 'dna' in $CONFIG_FILE."
    exit 1
fi

log "Pipeline completed!"
