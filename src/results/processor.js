/**
 * Result data processing utilities
 */

/**
 * Combine extracted data from all reports into a flat array.
 *
 * Identifier columns come first so the output can be joined back to the
 * study data: metadata-ingested reports carry TCode / docid / yearmonth
 * (column headers match metadata.csv's casing for TCode); every report
 * carries fileName. The metadata columns are only emitted when at least one
 * report has them, so ad-hoc uploads keep a clean header.
 *
 * @param {Object[]} reports - Array of report objects with extractions
 * @returns {Object[]} - Combined data array, identifiers first
 */
export function combineExtractedData(reports) {
    const anyMetadata = reports.some((r) => r.metadata);
    return reports.reduce((acc, r) => {
        if (r.extractions && r.extractions.length > 0) {
            const merged = {};
            for (const extraction of r.extractions) {
                const dataObj = extraction.data || {};
                Object.entries(dataObj).forEach(([key, value]) => {
                    merged[key] = value;
                });
            }
            const identifiers = anyMetadata
                ? {
                    TCode: r.metadata?.tcode ?? null,
                    docid: r.metadata?.docid ?? null,
                    yearmonth: r.metadata?.yearmonth ?? null,
                }
                : {};
            acc.push({
                ...identifiers,
                fileName: r.name,
                ...merged
            });
        }
        return acc;
    }, []);
}

/**
 * Convert JSON data to CSV format
 * @param {Object[]} data - Array of objects to convert to CSV
 * @returns {string} - CSV formatted string
 */
export function convertJsonToCsv(data) {
    if (!data || data.length === 0) return '';

    // Get all unique headers from all objects
    const headers = Array.from(new Set(data.flatMap(d => Object.keys(d))));

    // Create CSV header row
    const csvHeader = headers.map(header => `"${header}"`).join(',');

    // Create CSV data rows
    const csvRows = data.map(row => {
        return headers.map(header => {
            const value = row[header];
            if (value === null || value === undefined) {
                return '""';
            } else if (Array.isArray(value) || typeof value === 'object') {
                // Escape quotes in JSON strings for CSV
                return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
            } else {
                // Escape quotes in regular strings for CSV
                return `"${String(value).replace(/"/g, '""')}"`;
            }
        }).join(',');
    });

    return [csvHeader, ...csvRows].join('\n');
}

/**
 * Get all unique headers from data array
 * @param {Object[]} data - Array of data objects
 * @returns {string[]} - Array of unique header names
 */
export function getDataHeaders(data) {
    if (!data || !Array.isArray(data)) return [];
    return Array.from(new Set(data.flatMap(d => Object.keys(d))));
}
