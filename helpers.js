export function isSystemMetric(measurement) {
    const systemPrefixes = [
        'go_', 'http_', 'influxdb_', 'qc_', 'service_', 
        'storage_', 'task_', 'boltdb_', 'query_'
    ];
    return systemPrefixes.some(prefix => measurement.startsWith(prefix));
}

export function moistureToPercentage(moisture) {
    if (moisture <= 1500) return 100;
    if (moisture >= 3000) return 0;
    
    return Math.round(200 - (moisture / 15));
}
