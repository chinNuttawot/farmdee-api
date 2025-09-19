import { Hono } from "hono";
import { auth } from "../middlewares/auth";
import { responseSuccess, responseError } from "../utils/responseHelper";

const router = new Hono();

const rules = [
    "1. ทำประกันชีวิตปีแรกส่งเอง ปีต่อมาส่งให้",
    "2. ลาออกจากงานต้องแจ้งให้ทราบล่วงหน้า 1 เดือน",
    "3. งานนาปีไร่ละ 60 / คน ใครมีคนมาเพิ่มแบ่งกันเอง",
    "4. การเบิกเงินล่วงหน้าสามารถเบิกได้ 80 % ของงานที่ทำได้",
    "5. งานซ่อมใหญ่คิดเงินให้แบบเหมาจ่ายให้ตามความยากง่ายของงาน",
    "6. การหยุดงาน / ขาด / ลา ต้องแจ้งล่วงหน้าอย่างน้อย 3 วัน",
    "7. พูดจายุยง ส่อเสียด หรือทำให้แตกแยกในหมู่คณะ ตัดการให้โบนัสครึ่งปี",
    "8. การเช็ครถ / ซ่อมรถต้องช่วยกัน เอาแรงกัน",
].join("\n");

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
