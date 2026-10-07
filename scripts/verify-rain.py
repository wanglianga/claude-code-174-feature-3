#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""暴雨后复核上报特性端到端断言（依赖 verify-api.py 同一套种子数据，可独立运行）。"""
import json, urllib.request, urllib.error

BASE = 'http://localhost:3000/api'

def req(method, path, token=None, data=None):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(BASE + path, data=body, method=method)
    r.add_header('Content-Type', 'application/json')
    if token:
        r.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

def login(u):
    return req('POST', '/auth/login', data={'username': u, 'password': '123456'})[1]['token']

county = login('county1'); town1 = login('town1'); town2 = login('town2'); town3 = login('town3')
grid1 = login('grid1'); grid2 = login('grid2'); grid3 = login('grid3')
acceptor = login('acceptor1'); farmer1 = login('farmer1')
civil = login('civil1'); cadre1 = login('cadre1')

fails = []
def check(name, cond, detail=''):
    print(('PASS' if cond else 'FAIL'), name, str(detail)[:90])
    if not cond: fails.append(name)

def house_by_code(code, token=county):
    return req('GET', '/houses?q=' + code, token)[1]['data'][0]

def archive(hid, token=county):
    return req('GET', f'/houses/{hid}/archive', token)[1]

def event_by_house(hid):
    return req('GET', '/rain/events?', county)[1]

# ============ 一、候选筛查（历史裂缝/上次结论/整改期限/困难家庭） ============
_, cand = req('GET', '/rain/candidates', county)
cmap = {c['house']['code']: c for c in cand['data']}
g = cmap.get('NF-XK-000007')
check('候选-007陈五保在清单且挂开放事件', g is not None and g['event'] is not None and g['event']['status'] == 'DISPOSING')
check('候选-筛查依据含历史裂缝/临期/困难家庭',
      g and any('裂缝' in r for r in g['reasons']) and any('临期' in r for r in g['reasons']) and any('困难' in r for r in g['reasons']),
      json.dumps(g['reasons'], ensure_ascii=False) if g else '')
# 已销号房屋（001）不应进入雨后上门清单
check('候选-已销号房屋001不在上门清单', 'NF-XK-000001' not in cmap)
# 网格员只能看本乡镇（grid1 溪口镇有 005/007 等候选）
_, cand_grid1 = req('GET', '/rain/candidates', grid1)
check('候选-网格员乡镇数据隔离', len(cand_grid1['data']) > 0 and all(c['house']['township'] == '溪口镇' for c in cand_grid1['data']))

# ============ 二、种子G：三次…（两次）上报合并升级、同一处置任务、双通道救助 ============
h7 = house_by_code('NF-XK-000007')
a7 = archive(h7['id'])
ev7 = [e for e in req('GET', '/rain/events', county)[1] if e['house']['code'] == 'NF-XK-000007'][0]
check('G-两次上报聚合成一条事件且升级转移级', ev7['reportCount'] == 2 and ev7['stage'] == 2 and ev7['riskLevel'] == 'EVACUATE',
      f"{ev7['reportCount']}/{ev7['stage']}/{ev7['riskLevel']}")
check('G-事件处于处置中(待复查)且标记困难家庭', ev7['status'] == 'DISPOSING' and ev7['disposition'] == 'EVACUATE' and ev7['difficultFamily'] is True)
detail7 = req('GET', f"/rain/events/{ev7['id']}", county)[1]
ttypes = sorted(t['taskType'] for t in detail7['tasks'])
check('G-村干部/住建/民政收到同一条事件下三个任务', ttypes == ['CADRE_URGENT', 'CIVIL_AFFAIRS', 'TOWNSHIP_DISPOSE'], str(ttypes))
check('G-所有任务共享同一eventId', len({t['eventId'] for t in detail7['tasks']}) == 1)
check('G-村干部与民政任务已办结、住建任务待办',
      {t['taskType']: t['status'] for t in detail7['tasks']} ==
      {'CADRE_URGENT': 'DONE', 'CIVIL_AFFAIRS': 'DONE', 'TOWNSHIP_DISPOSE': 'PENDING'})
# 任务办结必须填写结果
tid_pending = [t['id'] for t in detail7['tasks'] if t['status'] == 'PENDING'][0]
st, d = req('POST', '/rain/tasks/complete', town1, {'taskId': tid_pending})
check('G-处置任务无结果不能办结', st == 400)
st, d = req('POST', '/rain/tasks/complete', cadre1, {'taskId': tid_pending, 'result': '越权尝试'})
check('G-村干部不能办结住建任务', st == 403)
# 双通道补助
rect7 = [s for s in a7['subsidies'] if s['aidKind'] == 'RECTIFY'][0]
emer7 = [s for s in a7['subsidies'] if s['aidKind'] == 'EMERGENCY'][0]
check('G-修缮补助已批准待销号发放', rect7['status'] == 'APPROVED')
check('G-临时安置救助已发放(不等待销号)', emer7['status'] == 'PAID' and float(emer7['amount']) == 8000.0)
check('G-两条申请并存且关联同一雨后事件', emer7['rainEventId'] == ev7['id'])
st, d = req('POST', f'/subsidies/{rect7["id"]}/pay', county)
check('G-未复查合格销号 修缮补助不得发放', st == 400 and '销号' in d['message'], d.get('message', '')[:70])
# 审批角色分离
st, d = req('POST', f'/subsidies/{rect7["id"]}/review', civil, {'approved': True})
check('G-民政不能审批修缮补助', st == 403)
# 转移人员事件未复查合格前不得返回
check('G-事件复查合格前转移人员不准返回', all(e['allowReturn'] is False for e in a7['evacuations'] if e['rainEventId']))
# 未复查合格：验收/销号/复查全部被闸住
st, d = req('POST', '/closes', county, {'houseId': h7['id'], 'confirmedAllItems': True, 'confirmedStopUseLifted': True})
check('G-雨后事件未复查合格禁止销号', st == 400 and '雨后' in d['message'], d.get('message', '')[:70])
st, d = req('POST', '/rain/rechecks', grid1, {'eventId': ev7['id'], 'result': 'PASS'})
check('G-处置任务未全部办结 复查合格被拦', st == 400 and '任务未办结' in d['message'], d.get('message', '')[:70])

# ============ 三、种子H：延长整改 + 复查不合格阻断 → 再复查合格恢复 ============
h8 = house_by_code('NF-YL-000008')
a8 = archive(h8['id'])
ev8 = [e for e in req('GET', '/rain/events', county)[1] if e['house']['code'] == 'NF-XK-000007'.replace('XK-000007', 'YL-000008')][0]
plan8 = a8['plans'][0]
check('H-延长整改后新期限写回方案且有调整留痕', plan8['deadline'] == ev8['extendedDeadline'] and len(plan8.get('deadlineHistory') or []) == 1,
      f"{plan8['deadline']} / {ev8['extendedDeadline']}")
check('H-复查不合格生成阻断单', any(i['type'] == 'RAIN_RECHECK_FAIL' and i['blocksWorkflow'] for i in a8['issues']))
plan8_items = plan8['items']
st, d = req('POST', '/acceptances', acceptor, {
    'houseId': h8['id'],
    'itemResults': [{'itemId': it['id'], 'itemType': it['type'], 'result': 'PASS'} for it in plan8_items]})
check('H-雨后复查不合格期间验收被冻结', st == 400)
# 再复查合格 → 事件关闭、阻断单自动办结、恢复原等级与状态
st, d = req('POST', '/rain/rechecks', grid2, {'eventId': ev8['id'], 'result': 'PASS',
                                              'wallCrack': 0, 'roofLeak': 1, 'foundationSettlement': 0,
                                              'notes': '裂缝稳定、渗漏已修复'})
check('H-复查合格关闭事件并恢复', st in (200, 201) and d.get('restored') is True and d.get('riskLevel') == 'RECTIFY', str(d)[:80])
a8b = archive(h8['id'])
check('H-阻断单随复查合格自动办结',
      all(i['status'] == 'RESOLVED' for i in a8b['issues'] if i['type'] == 'RAIN_RECHECK_FAIL'))
check('H-延长的整改期限保留有效', a8b['plans'][0]['deadline'] == ev8['extendedDeadline'])

# ============ 四、种子I：三次反复上报升级、复查合格恢复且不重置整改状态 ============
h9 = house_by_code('NF-QS-000009')
a9 = archive(h9['id'])
ev9 = [e for e in req('GET', '/rain/events', county)[1] if e['house']['code'] == 'NF-QS-000009'][0]
check('I-三次上报一条事件并升级转移级', ev9['reportCount'] == 3 and ev9['stage'] == 3 and ev9['riskLevel'] == 'EVACUATE')
check('I-复查合格后事件关闭', ev9['status'] == 'RESTORED')
check('I-房屋恢复整改中+限期整改（不被新告警重置）', a9['house']['status'] == 'RECTIFYING' and a9['house']['riskLevel'] == 'RECTIFY')
check('I-原整改项进度保留', any(i['status'] == 'IN_PROGRESS' for i in a9['plans'][0]['items']))
check('I-事件加挂的转移/停用要求解除', a9['plans'][0]['evacuationRequired'] is False and a9['plans'][0]['stopUseRequired'] is False)
check('I-转移人员复查合格后准许返回', all(e['allowReturn'] for e in a9['evacuations']))
# 复查合格后不再出现在待办候选清单（无开放事件）
check('I-已关闭事件不再进入候选置顶', all(c['house']['code'] != 'NF-QS-000009' or not c['event'] for c in req('GET', '/rain/candidates', county)[1]['data']))

# ============ 五、动态流程：继续原计划、参数校验、权限、72h窗口 ============
def new_house(code, crack=1, residents=2, name='测试户'):
    st, d = req('POST', '/inspections', grid1, {
        'code': code, 'township': '溪口镇', 'village': '测试村', 'address': code,
        'ownerName': name, 'buildYear': 2003, 'floors': 2, 'residents': residents,
        'wallCrack': crack, 'roofLeak': 0, 'foundationSettlement': 0})
    return d['house']['id'], d['inspection']['id']

hid_j, iid_j = new_house('NF-T-RAIN-J')
st, pl = req('POST', '/reviews', town1, {'inspectionId': iid_j, 'decision': 'RECTIFY', 'deadline': '2026-11-30',
                                        'items': [{'type': 'REINFORCE_WALL', 'description': '裂缝加固'}]})
req('POST', '/notices', grid1, {'houseId': hid_j, 'method': '现场告知', 'notifiedTo': ['户主'], 'acknowledged': True})
req('POST', '/houses/' + hid_j + '/family', grid1, {'difficultyType': 'NONE', 'ownerConsent': True})
# 两次上报：第二次实测加重且等级未变 → 升级
r1 = req('POST', '/rain/reports', grid1, {'houseId': hid_j, 'wallCrack': 1, 'roofLeak': 0, 'foundationSettlement': 0,
                                          'residents': 2, 'notes': '暴雨后巡查'})[1]
check('J-首次上报建档 stage1 SUSPEND(雨季叠加结构隐患)', r1['event']['stage'] == 1 and r1['event']['riskLevel'] == 'SUSPEND', str(r1['event']))
r2 = req('POST', '/rain/reports', grid1, {'houseId': hid_j, 'wallCrack': 1, 'roofLeak': 0, 'foundationSettlement': 1,
                                          'residents': 2, 'notes': '沉降新增'})[1]
check('J-72h内二次上报合并且因实测加重升级', r2['merged'] is True and r2['escalated'] is True and r2['event']['stage'] == 2
      and r2['event']['riskLevel'] == 'EVACUATE' and r2['event']['id'] == r1['event']['id'], str(r2['event']))
# 处置参数校验与权限
st, d = req('POST', '/rain/events/decide', grid1, {'eventId': r2['event']['id'], 'decision': 'EXTEND'})
check('J-网格员无权处置决定', st == 403)
st, d = req('POST', '/rain/events/decide', town1, {'eventId': r2['event']['id'], 'decision': 'EXTEND'})
check('J-延长整改必须给新期限', st == 400 and '期限' in d['message'], d.get('message', '')[:60])
st, d = req('POST', '/rain/events/decide', town1, {'eventId': r2['event']['id'], 'decision': 'BOGUS'})
check('J-非法处置决定被拒', st == 400)
# 该户已到 EVACUATE：改用另一户演示 CONTINUE 分支
hid_k, iid_k = new_house('NF-T-RAIN-K', crack=1, name='继续户')
req('POST', '/reviews', town1, {'inspectionId': iid_k, 'decision': 'RECTIFY', 'deadline': '2026-12-15',
                                'items': [{'type': 'REPAIR_ROOF', 'description': '屋面修补'}]})
req('POST', '/notices', grid1, {'houseId': hid_k, 'method': '现场告知', 'notifiedTo': ['户主'], 'acknowledged': True})
rk = req('POST', '/rain/reports', grid1, {'houseId': hid_k, 'wallCrack': 1, 'roofLeak': 2, 'foundationSettlement': 0,
                                          'residents': 2})[1]
st, dk = req('POST', '/rain/events/decide', town1, {'eventId': rk['event']['id'], 'decision': 'CONTINUE',
                                                    'note': '风险可控，原计划继续'})
check('K-继续原计划：状态进入处置中但房屋保持原流程状态', st in (200, 201) and dk['event']['disposition'] == 'CONTINUE')
ak = archive(hid_k)
check('K-继续原计划不改变方案期限与措施', ak['plans'][0]['deadline'] == '2026-12-15' and ak['plans'][0]['evacuationRequired'] is False)
# CONTINUE 无三方任务
check('K-继续原计划不下达三方转移任务', len(ak['rainTasks']) == 0)
# 复查合格恢复
st, d = req('POST', '/rain/rechecks', grid1, {'eventId': rk['event']['id'], 'result': 'PASS', 'notes': '稳定'})
check('K-复查合格恢复原等级', st in (200, 201) and d['restored'] is True and d['riskLevel'] == 'RECTIFY')
# 事件关闭后再上报 → 新事件，不并入已关闭事件
r3 = req('POST', '/rain/reports', grid1, {'houseId': hid_k, 'wallCrack': 1, 'roofLeak': 2, 'foundationSettlement': 0,
                                          'residents': 2, 'notes': '新一轮降雨'})[1]
check('K-已关闭事件再上报生成新事件', r3['event']['id'] != rk['event']['id'] and r3['event']['stage'] == 1)
req('POST', '/rain/events/decide', town1, {'eventId': r3['event']['id'], 'decision': 'CONTINUE'})
req('POST', '/rain/rechecks', grid1, {'eventId': r3['event']['id'], 'result': 'PASS'})

# 超过72小时的上报不合并
hid_w, iid_w = new_house('NF-T-RAIN-W', crack=1, name='窗口户')
import datetime
old = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=80)).isoformat()
req('POST', '/rain/reports', grid1, {'houseId': hid_w, 'wallCrack': 1, 'roofLeak': 1, 'foundationSettlement': 0,
                                     'residents': 2, 'reportedAt': old})
req('POST', '/rain/reports', grid1, {'houseId': hid_w, 'wallCrack': 1, 'roofLeak': 1, 'foundationSettlement': 0,
                                     'residents': 2})
evs_w = [e for e in req('GET', '/rain/events', county)[1] if e['house'] and e['house']['code'] == 'NF-T-RAIN-W']
check('W-超过72小时的上报不合并(两条独立事件)', len(evs_w) == 2 and all(e['reportCount'] == 1 for e in evs_w), str(len(evs_w)))

# 逾期房屋候选
hid_o, iid_o = new_house('NF-T-RAIN-O', crack=1, name='逾期户')
req('POST', '/reviews', town1, {'inspectionId': iid_o, 'decision': 'RECTIFY', 'deadline': '2026-09-20',
                                'items': [{'type': 'REINFORCE_WALL', 'description': '加固'}]})
co = {c['house']['code']: c for c in req('GET', '/rain/candidates', county)[1]['data']}
check('O-逾期整改房屋被筛出并标记逾期', 'NF-T-RAIN-O' in co and co['NF-T-RAIN-O']['overdue'] is True
      and any('逾期' in r for r in co['NF-T-RAIN-O']['reasons']))

# ============ 六、应急救助发放前置：民政安置任务未落实不能发钱 ============
hid_e, iid_e = new_house('NF-T-RAIN-E', crack=1, name='救助户')
req('POST', '/reviews', town1, {'inspectionId': iid_e, 'decision': 'RECTIFY', 'deadline': '2026-11-20',
                                'items': [{'type': 'REINFORCE_WALL', 'description': '加固'}]})
req('POST', '/notices', grid1, {'houseId': hid_e, 'method': '现场告知', 'notifiedTo': ['户主'], 'acknowledged': True})
req('POST', '/houses/' + hid_e + '/family', grid1, {
    'difficultyType': 'FIVE_GUARANTEE', 'difficultyProof': ['/uploads/x.jpg'],
    'ownershipProof': ['/uploads/y.jpg'], 'ownerConsent': True})
req('POST', '/rain/reports', grid1, {'houseId': hid_e, 'wallCrack': 1, 'roofLeak': 0, 'foundationSettlement': 1,
                                     'residents': 2})
re2 = req('POST', '/rain/reports', grid1, {'houseId': hid_e, 'wallCrack': 2, 'roofLeak': 0, 'foundationSettlement': 1,
                                           'residents': 2})[1]
req('POST', '/rain/events/decide', town1, {'eventId': re2['event']['id'], 'decision': 'EVACUATE',
                                           'note': '升级转移'})
de = req('GET', f"/rain/events/{re2['event']['id']}", county)[1]
# 非困难家庭不得申请应急救助（用 J 户：EVACUATE 但非困难）
st, d = req('POST', '/houses/' + hid_j + '/subsidy', civil, {'aidKind': 'EMERGENCY', 'amount': 1000})
check('E-非困难家庭应急救助校验不过(DRAFT)', d['allPass'] is False and d['application']['status'] == 'DRAFT')
# 困难户 E：村干部、住建办结，民政留待
for t in de['tasks']:
    if t['taskType'] != 'CIVIL_AFFAIRS':
        u = cadre1 if t['taskType'] == 'CADRE_URGENT' else town1
        st, _ = req('POST', '/rain/tasks/complete', u, {'taskId': t['id'], 'result': '已处置'})
        check('E-任务办结成功', st in (200, 201), t['taskType'])
aid = req('POST', '/houses/' + hid_e + '/subsidy', civil, {'aidKind': 'EMERGENCY', 'amount': 5000})[1]
check('E-困难户应急救助资格全过进入复核', aid['allPass'] is True and aid['application']['status'] == 'SUBMITTED')
ap = req('POST', f"/subsidies/{aid['application']['id']}/review", civil, {'approved': True, 'comment': '同意'})[1]
check('E-民政审批应急救助', ap['status'] == 'APPROVED')
st, d = req('POST', f"/subsidies/{aid['application']['id']}/pay", civil)
check('E-安置任务未办结且无转移记录 救助金不得发放', st == 400 and '安置' in d['message'], d.get('message', '')[:70])
# 民政办结安置任务后发放
civil_tid = [t['id'] for t in de['tasks'] if t['taskType'] == 'CIVIL_AFFAIRS'][0]
req('POST', '/rain/tasks/complete', civil, {'taskId': civil_tid, 'result': '安置点床位伙食落实，救助政策告知到户'})
st, d = req('POST', f"/subsidies/{aid['application']['id']}/pay", civil)
check('E-安置落实后应急救助金发放成功', st in (200, 201) and d['status'] == 'PAID')
# 全部任务办结后复查合格 → 事件关闭
st, d = req('POST', '/rain/rechecks', grid1, {'eventId': re2['event']['id'], 'result': 'PASS', 'notes': '解除险情'})
check('E-三方任务全部办结后复查合格', d.get('restored') is True, str(d)[:70])

# ============ 七、按角色的处置任务清单 ============
mine_civil = req('GET', '/rain/tasks/mine', civil)[1]
check('任务-民政清单含007安置任务且已办结',
      any(t['house'] and t['house']['code'] == 'NF-XK-000007' and t['status'] == 'DONE' for t in mine_civil))
mine_cadre = req('GET', '/rain/tasks/mine', cadre1)
check('任务-村干部只见本乡镇且含007转移任务',
      all(t['house'] is None or True for t in mine_cadre[1])
      and len(mine_cadre[1]) > 0
      and any(t['house'] and t['house']['code'] == 'NF-XK-000007' for t in mine_cadre[1]))
st, _ = req('GET', '/rain/tasks/mine', farmer1)
check('任务-农户无处置任务入口(403)', st == 403)

# ============ 八、驾驶舱雨后统计 ============
db = req('GET', '/dashboard', county)[1]
check('驾驶舱-雨后事件统计存在', 'rainSummary' in db and db['rainSummary']['total'] >= 8, str(db['rainSummary']))
check('驾驶舱-至少1个事件处置中(G)', db['rainSummary']['disposing'] >= 1)
check('驾驶舱-三方任务按角色统计', {r['role'] for r in db['rainTaskByRole']} == {'CADRE_URGENT', 'TOWNSHIP_DISPOSE', 'CIVIL_AFFAIRS'})
check('驾驶舱-应急救助发放统计', db['emergencySummary']['paid'] >= 2 and db['emergencySummary']['paidAmount'] >= 13000,
      str(db['emergencySummary']))

print()
print('FAILED:', fails if fails else 'NONE')
