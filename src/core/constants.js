/**
 * Core constants for the Medical Report Information Extractor
 */

// API provider identifiers
export const API_PROVIDERS = {
    OPENAI: 'openai',
    GEMINI: 'gemini',
    WEBLLM: 'webllm'
};

// Default LLM configuration
export const MAX_RETRIES = 3;

// Example report URLs for demo/testing
export const EXAMPLE_REPORT_URLS = [
    "https://raw.githubusercontent.com/jeyabbalas/medical-report-information-extractor/refs/heads/main/examples/bcn_generations_pathology_data/sample_reports/01.txt",
    "https://raw.githubusercontent.com/jeyabbalas/medical-report-information-extractor/refs/heads/main/examples/bcn_generations_pathology_data/sample_reports/02.txt",
    "https://raw.githubusercontent.com/jeyabbalas/medical-report-information-extractor/refs/heads/main/examples/bcn_generations_pathology_data/sample_reports/03.txt",
    "https://raw.githubusercontent.com/jeyabbalas/medical-report-information-extractor/refs/heads/main/examples/bcn_generations_pathology_data/sample_reports/04.txt",
    "https://raw.githubusercontent.com/jeyabbalas/medical-report-information-extractor/refs/heads/main/examples/bcn_generations_pathology_data/sample_reports/05.txt"
];

// IndexedDB record keys
export const DB_KEYS = {
    APP_CONFIG: 'appConfig',
    LLM_API_CREDS: 'llmApiCreds',
    MODEL: 'model'
};

// Default API base URLs
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Regex pattern for extracting JSON from LLM responses
export const JSON_EXTRACTION_REGEX = /```json\s*([\s\S]*?)\s*```/;
