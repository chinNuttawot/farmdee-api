import { Hono } from "hono";
import { auth } from "../middlewares/auth";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

const rules = {
    title: "เกณฑ์การใช้ไมล์",
    notes: [
        "ไมล์ที่สูงกว่า 500 ไมล์ ถือเป็นเที่ยวบินระยะไกล",
        "เกณฑ์นี้ใช้เฉพาะเส้นทางในประเทศ",
    ],
    oneWay: [
        { min: 4501, max: 4900, priceTHB: 5500 },
        { min: 4001, max: 4500, priceTHB: 5000 },
        { min: 3501, max: 4000, priceTHB: 4000 },
        { min: 3001, max: 3500, priceTHB: 3000 },
        { min: 0, max: 3000, priceTHB: 1 },
    ],
    roundTrip: [
        { min: 4501, max: 4900, priceTHB: 6000 },
        { min: 4001, max: 4500, priceTHB: 5000 },
        { min: 3501, max: 4000, priceTHB: 4000 },
        { min: 3001, max: 3500, priceTHB: 3000 },
        { min: 0, max: 3000, priceTHB: 1 },
    ],
}

/** ===== GET /rule (list ทั้งหมด) ===== */
router.get("/", auth, async (c) => {
    try {
        const res = rules;

        return responseSuccess(c, "fetched rule", res);
    } catch (err: any) {
        return responseError(c, "internal_error", 500, err?.message ?? String(err));
    }
});

export default router;
