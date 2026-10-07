import {
  DifficultyType,
  FamilyProfile,
  House,
  ReviewPlan,
  RiskLevel,
} from './entities';

/** 同一栋房屋三天（72 小时）内反复上报，聚合进同一条持续升级的风险事件 */
export const RAIN_MERGE_WINDOW_MS = 72 * 60 * 60 * 1000;
/** 整改期限临期阈值：7 天内到期视为临期 */
export const DEADLINE_SOON_DAYS = 7;

export function rankLevel(l: RiskLevel): number {
  return { [RiskLevel.NORMAL]: 0, [RiskLevel.RECTIFY]: 1, [RiskLevel.SUSPEND]: 2, [RiskLevel.EVACUATE]: 3 }[l] ?? 0;
}

export function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return rankLevel(a) >= rankLevel(b) ? a : b;
}

function bumpLevel(l: RiskLevel): RiskLevel {
  const order = [RiskLevel.NORMAL, RiskLevel.RECTIFY, RiskLevel.SUSPEND, RiskLevel.EVACUATE];
  const i = Math.min(order.indexOf(l) + 1, order.length - 1);
  return order[i];
}

export interface RainMeasure {
  wallCrack: number;
  roofLeak: number;
  foundationSettlement: number;
  residents: number;
}

/**
 * 72 小时内重复上报的合并升级规则：
 *  - 事件风险等级取「历次上报规则引擎结果」的最高等级；
 *  - 第二次上报且实测隐患较上次加重（裂缝/渗漏/沉降任一升档）但等级未变 → 上调一级；
 *  - 第三次及以上上报（反复确认险情持续）→ 在最高等级基础上再上调一级，封顶紧急转移。
 */
export function mergeRainReport(args: {
  prevStage: number;
  prevLevel: RiskLevel;
  prevMeasure: RainMeasure | null;
  evaluatedLevel: RiskLevel;
  measure: RainMeasure;
}): { stage: number; level: RiskLevel; escalated: boolean } {
  const stage = args.prevStage + 1;
  let level = maxLevel(args.prevLevel, args.evaluatedLevel);
  let escalated = rankLevel(args.evaluatedLevel) > rankLevel(args.prevLevel);
  if (stage === 2 && rankLevel(level) === rankLevel(args.prevLevel) && args.prevMeasure) {
    const worse =
      args.measure.wallCrack > args.prevMeasure.wallCrack ||
      args.measure.roofLeak > args.prevMeasure.roofLeak ||
      args.measure.foundationSettlement > args.prevMeasure.foundationSettlement;
    if (worse) {
      level = bumpLevel(level);
      escalated = true;
    }
  }
  if (stage >= 3 && rankLevel(level) < rankLevel(RiskLevel.EVACUATE)) {
    level = bumpLevel(level);
    escalated = true;
  }
  return { stage, level, escalated };
}

export interface RainCandidate {
  needsVisit: boolean;
  score: number;
  reasons: string[];
  overdue: boolean;
  deadlineSoon: boolean;
}

/**
 * 雨后上门候选筛查：从「历史裂缝 / 上次复查（验收）结论 / 整改期限 / 家庭困难」四个维度
 * 识别真正需要重新上门的整改期房屋，避免对所有房屋撒网式排查。
 */
export function scoreRainCandidate(
  house: House,
  plan: ReviewPlan | null,
  family: FamilyProfile | null,
  ctx: { now?: Date; lastRecheckResult?: string | null } = {},
): RainCandidate {
  const reasons: string[] = [];
  let score = 0;

  // 维度一：历史结构隐患（历史裂缝/沉降）
  const structural = house.wallCrack >= 1 || house.foundationSettlement >= 1;
  if (structural) {
    score++;
    const parts: string[] = [];
    if (house.wallCrack === 2) parts.push('历史墙体裂缝严重');
    else if (house.wallCrack === 1) parts.push('历史墙体明显裂缝');
    if (house.foundationSettlement === 2) parts.push('历史地基沉降严重');
    else if (house.foundationSettlement === 1) parts.push('历史明显地基沉降');
    reasons.push(parts.join('、'));
  }

  // 维度二：上次复查/验收结论
  const adverse = ctx.lastRecheckResult === 'FAIL';
  if (adverse) {
    score++;
    reasons.push('上次复查结论不合格（问题反弹在册）');
  }

  // 维度三：整改期限临期/逾期
  let overdue = false;
  let deadlineSoon = false;
  if (plan?.deadline) {
    const now = ctx.now ? ctx.now.getTime() : Date.now();
    const due = new Date(`${plan.deadline}T23:59:59`).getTime();
    overdue = due < now;
    deadlineSoon = !overdue && due - now <= DEADLINE_SOON_DAYS * 86400000;
    if (overdue) {
      score++;
      reasons.push(`整改期限已逾期（原定 ${plan.deadline}）`);
    } else if (deadlineSoon) {
      score++;
      reasons.push(`整改期限临期（${plan.deadline} 到期）`);
    }
  }

  // 维度四：困难家庭（雨后抗风险能力弱，优先上门）
  const difficult = !!family && family.difficultyType !== DifficultyType.NONE;
  if (difficult) {
    score++;
    reasons.push(`困难家庭（${family.difficultyType}），需优先核查并衔接救助`);
  }

  return { needsVisit: score >= 2, score, reasons, overdue, deadlineSoon };
}
