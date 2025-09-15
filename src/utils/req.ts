export function getIP(c: any) {
    return c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "";
}

export function getUA(c: any) {
    return c.req.header("user-agent") || "";
}
