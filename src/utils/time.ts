export function nowPlusDays(days: number) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().replace("T", " ").replace("Z", "");
}

export function toPgTimestamp(date: Date) {
    return date.toISOString().replace("T", " ").replace("Z", "");
}
