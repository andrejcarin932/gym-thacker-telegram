import { createClient } from "npm:@supabase/supabase-js@2";

const encoder = new TextEncoder();
const MEDIA_BUCKET = "club-media";
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const ALLOWED_MEDIA = new Map<string, { kind: "image" | "video"; extension: string }>([
  ["image/jpeg", { kind: "image", extension: "jpg" }],
  ["image/png", { kind: "image", extension: "png" }],
  ["image/webp", { kind: "image", extension: "webp" }],
  ["image/heic", { kind: "image", extension: "heic" }],
  ["image/heif", { kind: "image", extension: "heif" }],
  ["video/mp4", { kind: "video", extension: "mp4" }],
  ["video/quicktime", { kind: "video", extension: "mov" }],
  ["video/webm", { kind: "video", extension: "webm" }],
]);

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function responseJson(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin || "*",
      "access-control-allow-headers": "authorization, apikey, content-type, x-telegram-init-data",
      "access-control-allow-methods": "POST, OPTIONS",
      "vary": "Origin",
    },
  });
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(keyBytes: Uint8Array, message: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

async function sha256Hex(value: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function verifyTelegramInitData(initData: string, botToken: string) {
  const params = new URLSearchParams(initData);
  const suppliedHash = (params.get("hash") || "").toLowerCase();
  if (!suppliedHash) throw new HttpError(401, "Telegram не передал данные входа. Открой приложение из чата с ботом.");
  const fields: string[] = [];
  params.forEach((value, key) => { if (key !== "hash") fields.push(key + "=" + value); });
  fields.sort((left, right) => left.split("=", 1)[0].localeCompare(right.split("=", 1)[0]));
  const dataCheckString = fields.join("\n");
  const secretKey = await hmacSha256(encoder.encode("WebAppData"), botToken);
  const calculatedHash = bytesToHex(await hmacSha256(secretKey, dataCheckString));
  if (!constantTimeEqual(suppliedHash, calculatedHash)) throw new HttpError(401, "Не удалось подтвердить вход через Telegram.");

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > 24 * 60 * 60) {
    throw new HttpError(401, "Сеанс Telegram устарел. Закрой и снова открой приложение.");
  }
  let user: { id?: number; first_name?: string; username?: string };
  try { user = JSON.parse(params.get("user") || "{}"); }
  catch { throw new HttpError(401, "Не удалось прочитать профиль Telegram."); }
  if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0) throw new HttpError(401, "В данных Telegram нет идентификатора пользователя.");
  return { id: Number(user.id), firstName: String(user.first_name || ""), username: String(user.username || "") };
}

function makeAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const keyMapText = Deno.env.get("SUPABASE_SECRET_KEYS") || "{}";
  let keyMap: Record<string, string> = {};
  try { keyMap = JSON.parse(keyMapText); } catch { keyMap = {}; }
  const secretKey = keyMap.default || Object.values(keyMap).find((value) => typeof value === "string") || Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !secretKey) throw new HttpError(503, "Сервер базы не настроен.");
  return createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

async function ensureProfile(db: ReturnType<typeof makeAdminClient>, telegramUser: { id: number; firstName: string; username: string }) {
  const { error: insertError } = await db.from("profiles").upsert({
    telegram_id: telegramUser.id,
    telegram_username: telegramUser.username || null,
    telegram_first_name: telegramUser.firstName || null,
    nickname: cleanText(telegramUser.username || telegramUser.firstName, 24),
  }, { onConflict: "telegram_id", ignoreDuplicates: true });
  if (insertError) throw new HttpError(500, "Не удалось создать профиль.");
  const { data, error } = await db.from("profiles").select("*").eq("telegram_id", telegramUser.id).single();
  if (error || !data) throw new HttpError(500, "Не удалось загрузить профиль.");
  return data;
}

async function getMembership(db: ReturnType<typeof makeAdminClient>, telegramId: number) {
  const { data: member, error } = await db.from("club_members").select("club_id, role, joined_at").eq("telegram_id", telegramId).maybeSingle();
  if (error) throw new HttpError(500, "Не удалось проверить членство в клубе.");
  if (!member) return null;
  const { data: club, error: clubError } = await db.from("clubs").select("id, name, owner_telegram_id").eq("id", member.club_id).single();
  if (clubError || !club) throw new HttpError(500, "Не удалось загрузить клуб.");
  return { ...member, club };
}

async function requireMembership(db: ReturnType<typeof makeAdminClient>, telegramId: number) {
  const membership = await getMembership(db, telegramId);
  if (!membership) throw new HttpError(403, "Сначала вступи в закрытую группу своего зала.");
  return membership;
}

async function findAcceptedFriendIds(db: ReturnType<typeof makeAdminClient>, clubId: string, telegramId: number) {
  const { data, error } = await db.from("friend_requests").select("requester_id, recipient_id")
    .eq("club_id", clubId).eq("status", "accepted")
    .or(`requester_id.eq.${telegramId},recipient_id.eq.${telegramId}`);
  if (error) throw new HttpError(500, "Не удалось загрузить список друзей.");
  return Array.from(new Set((data || []).map((row) => Number(row.requester_id) === telegramId ? Number(row.recipient_id) : Number(row.requester_id))));
}

function publicProfile(profile: Record<string, unknown>) {
  const hide = profile.hide_personal_stats !== false;
  return {
    telegramId: Number(profile.telegram_id),
    nickname: profile.nickname || profile.telegram_first_name || "Участник",
    age: hide ? null : profile.age,
    weightKg: hide ? null : profile.weight_kg,
    category: hide ? null : profile.category,
    experience: profile.training_experience || "",
    hidePersonalStats: hide,
  };
}

async function actionMe(db: ReturnType<typeof makeAdminClient>, user: { id: number; firstName: string; username: string }) {
  const profile = await ensureProfile(db, user);
  const membership = await getMembership(db, user.id);
  const { data: existingClub, error: clubError } = await db.from("clubs").select("id").limit(1).maybeSingle();
  if (clubError) throw new HttpError(500, "Не удалось проверить клуб.");
  return {
    authenticated: true,
    profile,
    club: membership ? { id: membership.club.id, name: membership.club.name, role: membership.role } : null,
    hasClub: Boolean(existingClub),
  };
}

async function actionCreateClub(db: ReturnType<typeof makeAdminClient>, user: { id: number; firstName: string; username: string }, body: Record<string, unknown>) {
  const expectedCode = Deno.env.get("OWNER_BOOTSTRAP_CODE") || "";
  const suppliedCode = String(body.bootstrapCode || "");
  if (!expectedCode || !constantTimeEqual(suppliedCode, expectedCode)) throw new HttpError(403, "Код создания клуба неверный.");
  if (await getMembership(db, user.id)) throw new HttpError(409, "Ты уже состоишь в клубе.");
  const { data: existing } = await db.from("clubs").select("id").limit(1).maybeSingle();
  if (existing) throw new HttpError(409, "Клуб уже создан. Войди по приглашению владельца.");
  const profile = await ensureProfile(db, user);
  const name = cleanText(body.name || "Мой зал", 48);
  if (name.length < 2) throw new HttpError(400, "Название клуба должно содержать минимум 2 символа.");
  const inviteCode = crypto.randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
  const inviteHash = await sha256Hex(inviteCode);
  const { data: club, error } = await db.from("clubs").insert({ name, invite_code_hash: inviteHash, owner_telegram_id: user.id }).select("id,name").single();
  if (error || !club) throw new HttpError(500, "Не удалось создать клуб. Возможно, он уже существует.");
  const { error: memberError } = await db.from("club_members").insert({ club_id: club.id, telegram_id: user.id, role: "owner" });
  if (memberError) throw new HttpError(500, "Клуб создан, но профиль владельца не добавился. Обратись к настройке проекта.");
  return { club: { ...club, role: "owner" }, profile, inviteCode };
}

async function actionRotateInvite(db: ReturnType<typeof makeAdminClient>, user: { id: number }) {
  const membership = await requireMembership(db, user.id);
  if (membership.role !== "owner") throw new HttpError(403, "Новый код может создать только владелец клуба.");
  const inviteCode = crypto.randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
  const inviteHash = await sha256Hex(inviteCode);
  const { error } = await db.from("clubs").update({ invite_code_hash: inviteHash }).eq("id", membership.club_id);
  if (error) throw new HttpError(500, "Не удалось обновить код приглашения.");
  return { inviteCode };
}

async function actionJoinClub(db: ReturnType<typeof makeAdminClient>, user: { id: number; firstName: string; username: string }, body: Record<string, unknown>) {
  const code = cleanText(body.inviteCode, 40).toUpperCase();
  if (!code) throw new HttpError(400, "Введи код приглашения.");
  await ensureProfile(db, user);
  const { data: existing } = await db.from("club_members").select("club_id").eq("telegram_id", user.id).maybeSingle();
  if (existing) throw new HttpError(409, "Ты уже состоишь в клубе.");
  const { data: club, error } = await db.from("clubs").select("id,name").eq("invite_code_hash", await sha256Hex(code)).maybeSingle();
  if (error || !club) throw new HttpError(404, "Такого кода приглашения нет.");
  const { error: memberError } = await db.from("club_members").insert({ club_id: club.id, telegram_id: user.id });
  if (memberError) throw new HttpError(500, "Не удалось добавить тебя в группу.");
  return { club };
}

async function actionSaveProfile(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  await requireMembership(db, user.id);
  const nickname = cleanText(body.nickname, 24);
  if (nickname.length < 2) throw new HttpError(400, "Никнейм должен содержать минимум 2 символа.");
  const age = body.age === "" || body.age == null ? null : Number(body.age);
  const weight = body.weightKg === "" || body.weightKg == null ? null : Number(body.weightKg);
  if (age !== null && (!Number.isInteger(age) || age < 14 || age > 99)) throw new HttpError(400, "Проверь возраст.");
  if (weight !== null && (!Number.isFinite(weight) || weight < 30 || weight > 300)) throw new HttpError(400, "Проверь вес тела.");
  const experience = cleanText(body.experience, 80);
  const category = ["men", "women", "open"].includes(String(body.category)) ? String(body.category) : null;
  const theme = ["red", "blue", "purple", "light"].includes(String(body.theme)) ? String(body.theme) : "red";
  const { data, error } = await db.from("profiles").update({
    nickname, age, weight_kg: weight, training_experience: experience, category,
    hide_personal_stats: body.hidePersonalStats !== false, theme, updated_at: new Date().toISOString(),
  }).eq("telegram_id", user.id).select("*").single();
  if (error || !data) throw new HttpError(500, "Не удалось сохранить профиль.");
  return { profile: data };
}

async function actionFriends(db: ReturnType<typeof makeAdminClient>, user: { id: number }) {
  const membership = await requireMembership(db, user.id);
  const { data: relationships, error } = await db.from("friend_requests").select("*")
    .eq("club_id", membership.club_id).or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`);
  if (error) throw new HttpError(500, "Не удалось загрузить друзей.");
  const rows = relationships || [];
  const ids = Array.from(new Set(rows.filter((row) => row.status === "accepted").map((row) => Number(row.requester_id) === user.id ? Number(row.recipient_id) : Number(row.requester_id))));
  const incoming = rows.filter((row) => row.status === "pending" && Number(row.recipient_id) === user.id);
  const outgoing = rows.filter((row) => row.status === "pending" && Number(row.requester_id) === user.id);
  const profileIds = Array.from(new Set([...ids, ...incoming.map((row) => Number(row.requester_id)), ...outgoing.map((row) => Number(row.recipient_id))]));
  const { data: profiles, error: profileError } = profileIds.length
    ? await db.from("profiles").select("*").in("telegram_id", profileIds)
    : { data: [], error: null };
  if (profileError) throw new HttpError(500, "Не удалось загрузить профили друзей.");
  const profileMap = new Map((profiles || []).map((profile) => [Number(profile.telegram_id), publicProfile(profile)]));
  return {
    friends: ids.map((id) => profileMap.get(id)).filter(Boolean),
    incoming: incoming.map((row) => ({ id: row.id, profile: profileMap.get(Number(row.requester_id)) })).filter((row) => row.profile),
    outgoing: outgoing.map((row) => ({ id: row.id, profile: profileMap.get(Number(row.recipient_id)) })).filter((row) => row.profile),
  };
}

async function actionSearchMembers(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  const membership = await requireMembership(db, user.id);
  const query = cleanText(body.query, 32);
  if (query.length < 2) return { members: [] };
  const { data: memberRows, error: membersError } = await db.from("club_members").select("telegram_id").eq("club_id", membership.club_id);
  if (membersError) throw new HttpError(500, "Не удалось найти участников.");
  const memberIds = (memberRows || []).map((row) => Number(row.telegram_id)).filter((id) => id !== user.id);
  if (!memberIds.length) return { members: [] };
  const { data, error } = await db.from("profiles").select("*").in("telegram_id", memberIds).ilike("nickname", `%${query}%`).limit(12);
  if (error) throw new HttpError(500, "Не удалось найти участников.");
  return { members: (data || []).map(publicProfile) };
}

async function actionFriendRequest(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  const membership = await requireMembership(db, user.id);
  const targetId = Number(body.targetId);
  if (!Number.isSafeInteger(targetId) || targetId === user.id) throw new HttpError(400, "Выбери другого участника.");
  const { data: targetMember } = await db.from("club_members").select("telegram_id").eq("club_id", membership.club_id).eq("telegram_id", targetId).maybeSingle();
  if (!targetMember) throw new HttpError(404, "Участник не найден в этой группе.");
  const { data: reverse } = await db.from("friend_requests").select("id,status").eq("club_id", membership.club_id).eq("requester_id", targetId).eq("recipient_id", user.id).maybeSingle();
  if (reverse?.status === "accepted") return { status: "accepted" };
  if (reverse?.status === "pending") {
    const { error } = await db.from("friend_requests").update({ status: "accepted", updated_at: new Date().toISOString() }).eq("id", reverse.id);
    if (error) throw new HttpError(500, "Не удалось подтвердить дружбу.");
    return { status: "accepted" };
  }
  const { data: forward } = await db.from("friend_requests").select("id,status").eq("club_id", membership.club_id).eq("requester_id", user.id).eq("recipient_id", targetId).maybeSingle();
  if (forward?.status === "accepted") return { status: "accepted" };
  if (forward?.status === "pending") return { status: "pending" };
  if (forward?.status === "declined") {
    const { error } = await db.from("friend_requests").update({ status: "pending", updated_at: new Date().toISOString() }).eq("id", forward.id);
    if (error) throw new HttpError(500, "Не удалось отправить заявку.");
    return { status: "pending" };
  }
  const { error } = await db.from("friend_requests").insert({ club_id: membership.club_id, requester_id: user.id, recipient_id: targetId, status: "pending" });
  if (error) throw new HttpError(500, "Не удалось отправить заявку.");
  return { status: "pending" };
}

async function actionRespondFriend(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  const membership = await requireMembership(db, user.id);
  const status = body.accept ? "accepted" : "declined";
  const { data, error } = await db.from("friend_requests").update({ status, updated_at: new Date().toISOString() })
    .eq("id", String(body.requestId || "")).eq("club_id", membership.club_id).eq("recipient_id", user.id).eq("status", "pending").select("id").maybeSingle();
  if (error || !data) throw new HttpError(404, "Заявка уже обработана или не найдена.");
  return { status };
}

async function actionRemoveFriend(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  const membership = await requireMembership(db, user.id);
  const targetId = Number(body.targetId);
  const { error } = await db.from("friend_requests").delete().eq("club_id", membership.club_id).eq("status", "accepted")
    .or(`and(requester_id.eq.${user.id},recipient_id.eq.${targetId}),and(requester_id.eq.${targetId},recipient_id.eq.${user.id})`);
  if (error) throw new HttpError(500, "Не удалось удалить участника из друзей.");
  return { ok: true };
}

async function signedMediaUrls(db: ReturnType<typeof makeAdminClient>, paths: string[]) {
  if (!paths.length) return new Map<string, string>();
  const { data, error } = await db.storage.from(MEDIA_BUCKET).createSignedUrls(paths, 60 * 60);
  if (error) return new Map<string, string>();
  return new Map((data || []).filter((item) => item.signedUrl).map((item) => [item.path, item.signedUrl]));
}

async function actionFeed(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  const membership = await requireMembership(db, user.id);
  const { data: posts, error } = await db.from("posts").select("*").eq("club_id", membership.club_id).order("created_at", { ascending: false }).limit(40);
  if (error) throw new HttpError(500, "Не удалось загрузить ленту.");
  const rows = posts || [];
  const friendIds = await findAcceptedFriendIds(db, membership.club_id, user.id);
  const filtered = body.filter === "friends" ? rows.filter((post) => Number(post.author_id) === user.id || friendIds.includes(Number(post.author_id))) : rows;
  const postIds = filtered.map((post) => post.id);
  const profileIds = Array.from(new Set(filtered.map((post) => Number(post.author_id))));
  const [{ data: profiles }, { data: comments }, { data: likes }] = await Promise.all([
    profileIds.length ? db.from("profiles").select("*").in("telegram_id", profileIds) : Promise.resolve({ data: [] }),
    postIds.length ? db.from("post_comments").select("id,post_id,author_id,body,created_at").in("post_id", postIds).order("created_at", { ascending: true }) : Promise.resolve({ data: [] }),
    postIds.length ? db.from("post_likes").select("post_id,telegram_id").in("post_id", postIds) : Promise.resolve({ data: [] }),
  ]);
  const commentRows = comments || [];
  const commentProfileIds = Array.from(new Set(commentRows.map((item) => Number(item.author_id))));
  const { data: commentProfiles } = commentProfileIds.length ? await db.from("profiles").select("*").in("telegram_id", commentProfileIds) : { data: [] };
  const profileMap = new Map([...(profiles || []), ...(commentProfiles || [])].map((profile) => [Number(profile.telegram_id), publicProfile(profile)]));
  const mediaPaths = filtered.map((post) => post.media_path).filter(Boolean) as string[];
  const urlMap = await signedMediaUrls(db, mediaPaths);
  const commentsByPost = new Map<string, unknown[]>();
  for (const item of commentRows) {
    const list = commentsByPost.get(item.post_id) || [];
    list.push({ id: item.id, author: profileMap.get(Number(item.author_id))?.nickname || "Участник", body: item.body, createdAt: item.created_at });
    commentsByPost.set(item.post_id, list);
  }
  const likesByPost = new Map<string, number[]>();
  for (const item of likes || []) {
    const list = likesByPost.get(item.post_id) || [];
    list.push(Number(item.telegram_id)); likesByPost.set(item.post_id, list);
  }
  return { posts: filtered.map((post) => ({
    id: post.id, authorId: Number(post.author_id), author: profileMap.get(Number(post.author_id)) || { nickname: "Участник" },
    caption: post.caption, mediaType: post.media_kind, mediaUrl: post.media_path ? urlMap.get(post.media_path) || null : null,
    workout: post.workout, createdAt: post.created_at,
    likes: (likesByPost.get(post.id) || []).length, liked: (likesByPost.get(post.id) || []).includes(user.id),
    comments: commentsByPost.get(post.id) || [],
  })) };
}

async function actionLeaderboard(db: ReturnType<typeof makeAdminClient>, user: { id: number }) {
  const membership = await requireMembership(db, user.id);
  const { data: memberRows, error: memberError } = await db.from("club_members").select("telegram_id").eq("club_id", membership.club_id).limit(200);
  if (memberError) throw new HttpError(500, "Не удалось загрузить участников клуба.");
  const ids = (memberRows || []).map((row) => Number(row.telegram_id));
  if (!ids.length) return { entries: [] };
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [{ data: profiles, error: profileError }, { data: workouts, error: workoutError }] = await Promise.all([
    db.from("profiles").select("*").in("telegram_id", ids),
    db.from("workouts").select("telegram_id").in("telegram_id", ids).gte("workout_date", cutoff),
  ]);
  if (profileError || workoutError) throw new HttpError(500, "Не удалось посчитать рейтинг клуба.");
  const counts = new Map<number, number>();
  for (const row of workouts || []) counts.set(Number(row.telegram_id), (counts.get(Number(row.telegram_id)) || 0) + 1);
  const profileMap = new Map((profiles || []).map((profile) => [Number(profile.telegram_id), publicProfile(profile)]));
  const entries = ids.map((id) => ({ telegramId: id, nickname: profileMap.get(id)?.nickname || "Участник", count: counts.get(id) || 0, me: id === user.id }))
    .sort((left, right) => right.count - left.count || left.nickname.localeCompare(right.nickname, "ru"))
    .slice(0, 20);
  return { entries };
}

async function actionUploadUrl(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  const membership = await requireMembership(db, user.id);
  const mime = String(body.mimeType || "");
  const media = ALLOWED_MEDIA.get(mime);
  const size = Number(body.size);
  if (!media || !Number.isFinite(size) || size <= 0 || size > MAX_MEDIA_BYTES) {
    throw new HttpError(400, "Подойдут JPG, PNG, WebP, HEIC, MP4, MOV или WebM размером до 25 МБ.");
  }
  const path = `${membership.club_id}/${user.id}/${crypto.randomUUID()}.${media.extension}`;
  const { data, error } = await db.storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new HttpError(500, "Не удалось подготовить загрузку файла.");
  return { path, token: data.token, mediaKind: media.kind };
}

async function actionCreatePost(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  const membership = await requireMembership(db, user.id);
  const caption = cleanText(body.caption, 360);
  const mediaPath = cleanText(body.mediaPath, 250) || null;
  const mediaKind = ["image", "video"].includes(String(body.mediaKind)) ? String(body.mediaKind) : null;
  if (mediaPath && !mediaPath.startsWith(`${membership.club_id}/${user.id}/`)) throw new HttpError(403, "Этот файл не принадлежит твоему профилю.");
  if (!caption && !mediaPath) throw new HttpError(400, "Добавь текст, фото или видео.");
  const workout = body.workout && typeof body.workout === "object" ? body.workout : null;
  const { data, error } = await db.from("posts").insert({ club_id: membership.club_id, author_id: user.id, caption, media_path: mediaPath, media_kind: mediaPath ? mediaKind : null, workout }).select("id").single();
  if (error || !data) throw new HttpError(500, "Не удалось опубликовать запись.");
  return { id: data.id };
}

async function actionToggleLike(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  const membership = await requireMembership(db, user.id);
  const postId = String(body.postId || "");
  const { data: post } = await db.from("posts").select("id").eq("id", postId).eq("club_id", membership.club_id).maybeSingle();
  if (!post) throw new HttpError(404, "Публикация не найдена.");
  const { data: like } = await db.from("post_likes").select("post_id").eq("post_id", postId).eq("telegram_id", user.id).maybeSingle();
  if (like) {
    const { error } = await db.from("post_likes").delete().eq("post_id", postId).eq("telegram_id", user.id);
    if (error) throw new HttpError(500, "Не удалось убрать реакцию.");
    return { liked: false };
  }
  const { error } = await db.from("post_likes").insert({ post_id: postId, telegram_id: user.id });
  if (error) throw new HttpError(500, "Не удалось поставить реакцию.");
  return { liked: true };
}

async function actionComment(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  const membership = await requireMembership(db, user.id);
  const postId = String(body.postId || "");
  const text = cleanText(body.body, 180);
  if (!text) throw new HttpError(400, "Напиши комментарий.");
  const { data: post } = await db.from("posts").select("id").eq("id", postId).eq("club_id", membership.club_id).maybeSingle();
  if (!post) throw new HttpError(404, "Публикация не найдена.");
  const { error } = await db.from("post_comments").insert({ post_id: postId, author_id: user.id, body: text });
  if (error) throw new HttpError(500, "Не удалось сохранить комментарий.");
  return { ok: true };
}

async function actionDeletePost(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  const membership = await requireMembership(db, user.id);
  const postId = String(body.postId || "");
  const { data: post } = await db.from("posts").select("id,author_id,media_path").eq("id", postId).eq("club_id", membership.club_id).maybeSingle();
  if (!post) throw new HttpError(404, "Публикация не найдена.");
  if (Number(post.author_id) !== user.id && membership.role !== "owner") throw new HttpError(403, "Удалить публикацию может её автор или владелец группы.");
  const { error } = await db.from("posts").delete().eq("id", postId);
  if (error) throw new HttpError(500, "Не удалось удалить публикацию.");
  if (post.media_path) await db.storage.from(MEDIA_BUCKET).remove([post.media_path]);
  return { ok: true };
}

async function actionGetData(db: ReturnType<typeof makeAdminClient>, user: { id: number }) {
  await requireMembership(db, user.id);
  const [{ data: workouts, error: workoutError }, { data: profile, error: profileError }] = await Promise.all([
    db.from("workouts").select("client_id,workout_date,exercises,program_context").eq("telegram_id", user.id).order("workout_date", { ascending: false }).limit(500),
    db.from("profiles").select("program,theme").eq("telegram_id", user.id).single(),
  ]);
  if (workoutError || profileError) throw new HttpError(500, "Не удалось синхронизировать дневник.");
  return { workouts: (workouts || []).map((row) => ({ id: Number(row.client_id) || row.client_id, date: row.workout_date, exercises: row.exercises, programContext: row.program_context })), program: profile?.program || null, theme: profile?.theme || "red" };
}

function normalizeWorkoutRows(userId: number, body: Record<string, unknown>) {
  if (!Array.isArray(body.workouts) || body.workouts.length > 500) throw new HttpError(400, "Слишком много записей для синхронизации.");
  return (body.workouts as Array<Record<string, unknown>>).map((workout) => {
    const clientId = cleanText(workout.id, 80);
    const workoutDate = String(workout.date || "");
    const date = new Date(workoutDate);
    if (!clientId || Number.isNaN(date.getTime()) || !Array.isArray(workout.exercises) || workout.exercises.length > 40) throw new HttpError(400, "В журнале есть запись, которую не удалось прочитать.");
    return { telegram_id: userId, client_id: clientId, workout_date: date.toISOString(), exercises: workout.exercises, program_context: workout.programContext || null, updated_at: new Date().toISOString() };
  });
}

async function actionSaveWorkouts(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  await requireMembership(db, user.id);
  const rows = normalizeWorkoutRows(user.id, body);
  if (rows.length) {
    const { error } = await db.from("workouts").upsert(rows, { onConflict: "telegram_id,client_id" });
    if (error) throw new HttpError(500, "Не удалось сохранить историю тренировок.");
  }
  return { saved: rows.length };
}

async function actionReplaceWorkouts(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  await requireMembership(db, user.id);
  const rows = normalizeWorkoutRows(user.id, body);
  if (rows.length) {
    const { error } = await db.from("workouts").upsert(rows, { onConflict: "telegram_id,client_id" });
    if (error) throw new HttpError(500, "Не удалось импортировать историю тренировок.");
  }
  const { data: existing, error: existingError } = await db.from("workouts").select("client_id").eq("telegram_id", user.id);
  if (existingError) throw new HttpError(500, "Не удалось обновить историю тренировок.");
  const ids = new Set(rows.map((row) => row.client_id));
  const stale = (existing || []).map((row) => row.client_id).filter((id) => !ids.has(id));
  if (stale.length) {
    const { error } = await db.from("workouts").delete().eq("telegram_id", user.id).in("client_id", stale);
    if (error) throw new HttpError(500, "Не удалось удалить старые записи при импорте.");
  }
  return { saved: rows.length };
}

async function actionDeleteWorkouts(db: ReturnType<typeof makeAdminClient>, user: { id: number }, body: Record<string, unknown>) {
  await requireMembership(db, user.id);
  if (!Array.isArray(body.ids) || body.ids.length > 500) throw new HttpError(400, "Не удалось прочитать список удаляемых тренировок.");
  const ids = body.ids.map((id) => cleanText(id, 80)).filter(Boolean);
  if (!ids.length) return { deleted: 0 };
  const { error, count } = await db.from("workouts").delete({ count: "exact" }).eq("telegram_id", user.id).in("client_id", ids);
  if (error) throw new HttpError(500, "Не удалось удалить тренировку из облака.");
  return { deleted: count || 0 };
}

async function actionClearWorkouts(db: ReturnType<typeof makeAdminClient>, user: { id: number }) {
  await requireMembership(db, user.id);
  const { error, count } = await db.from("workouts").delete({ count: "exact" }).eq("telegram_id", user.id);
  if (error) throw new HttpError(500, "Не удалось очистить историю в облаке.");
  return { deleted: count || 0 };
}

async function routeAction(db: ReturnType<typeof makeAdminClient>, user: { id: number; firstName: string; username: string }, body: Record<string, unknown>) {
  const action = String(body.action || "");
  switch (action) {
    case "me": return actionMe(db, user);
    case "create_club": return actionCreateClub(db, user, body);
    case "join_club": return actionJoinClub(db, user, body);
    case "rotate_invite": return actionRotateInvite(db, user);
    case "save_profile": return actionSaveProfile(db, user, body);
    case "friends": return actionFriends(db, user);
    case "search_members": return actionSearchMembers(db, user, body);
    case "friend_request": return actionFriendRequest(db, user, body);
    case "respond_friend": return actionRespondFriend(db, user, body);
    case "remove_friend": return actionRemoveFriend(db, user, body);
    case "feed": return actionFeed(db, user, body);
    case "leaderboard": return actionLeaderboard(db, user);
    case "upload_url": return actionUploadUrl(db, user, body);
    case "create_post": return actionCreatePost(db, user, body);
    case "toggle_like": return actionToggleLike(db, user, body);
    case "comment": return actionComment(db, user, body);
    case "delete_post": return actionDeletePost(db, user, body);
    case "get_data": return actionGetData(db, user);
    case "save_workouts": return actionSaveWorkouts(db, user, body);
    case "replace_workouts": return actionReplaceWorkouts(db, user, body);
    case "delete_workouts": return actionDeleteWorkouts(db, user, body);
    case "clear_workouts": return actionClearWorkouts(db, user);
    case "save_program": {
      await requireMembership(db, user.id);
      const program = body.program && typeof body.program === "object" ? body.program : null;
      const theme = ["red", "blue", "purple", "light"].includes(String(body.theme)) ? String(body.theme) : undefined;
      const patch: Record<string, unknown> = { program, updated_at: new Date().toISOString() };
      if (theme) patch.theme = theme;
      const { error } = await db.from("profiles").update(patch).eq("telegram_id", user.id);
      if (error) throw new HttpError(500, "Не удалось сохранить программу.");
      return { ok: true };
    }
    default: throw new HttpError(404, "Неизвестное действие приложения.");
  }
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  const allowedOrigin = Deno.env.get("APP_ORIGIN") || "https://andrejcarin932.github.io";
  if (origin && origin !== allowedOrigin && origin !== "null") return responseJson({ error: "Источник запроса не разрешён." }, 403, allowedOrigin);
  if (request.method === "OPTIONS") return new Response("ok", { headers: {
    "access-control-allow-origin": origin === "null" ? "null" : allowedOrigin,
    "access-control-allow-headers": "authorization, apikey, content-type, x-telegram-init-data",
    "access-control-allow-methods": "POST, OPTIONS",
    "vary": "Origin",
  } });
  if (request.method !== "POST") return responseJson({ error: "Используй POST." }, 405, allowedOrigin);
  try {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
    if (!botToken) throw new HttpError(503, "На сервере не задан токен Telegram-бота.");
    const initData = request.headers.get("x-telegram-init-data") || "";
    const user = await verifyTelegramInitData(initData, botToken);
    const body = await request.json();
    const db = makeAdminClient();
    const result = await routeAction(db, user, body);
    return responseJson({ ok: true, data: result }, 200, origin === "null" ? "null" : allowedOrigin);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Внутренняя ошибка сервера.";
    if (status >= 500) console.error("club-api error", error);
    return responseJson({ ok: false, error: message }, status, origin === "null" ? "null" : allowedOrigin);
  }
});