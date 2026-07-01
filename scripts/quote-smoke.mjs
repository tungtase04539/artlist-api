// Gọi QUOTE (read-only, KHÔNG tốn credits) để kiểm tra cookie/auth trước khi tạo video.
// Chạy:  npm run test:quote   (hoặc: node scripts/quote-smoke.mjs "prompt tuỳ chọn")
import { getCostQuote } from '../src/artlist/client.js';

const params = {
  prompt: process.argv[2] || 'a red panda skateboarding',
  duration: 4,
  resolution: '720p',
  aspectRatio: '16:9',
  generateAudio: true,
  modelId: 2524,
  modelGroupId: 358,
};

try {
  const q = await getCostQuote(params);
  console.log('✅ QUOTE OK — cookie hợp lệ!');
  console.log('   price (credits):', q.price);
  console.log('   timestamp     :', q.timestamp);
  console.log('   signature     :', String(q.costQuoteDigitalSignature).slice(0, 28) + '...');
  console.log('\n→ Cookie hoạt động. Giờ có thể POST /api/videos để tạo video thật (sẽ tốn credits).');
} catch (err) {
  console.error('❌ QUOTE lỗi:', err.message);
  console.error('   → Nếu UNAUTHORIZED/Session hết hạn: cookie sai hoặc đã hết hạn.');
  console.error('     Lấy cookie MỚI từ DevTools (kèm cf_clearance/__cf_bm mới) và cập nhật ARTLIST_COOKIE trong .env.');
  process.exitCode = 1;
}
