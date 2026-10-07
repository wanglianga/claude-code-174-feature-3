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
    _, d = req('POST', '/auth/login', data={'username': u, 'password': '123456'})
    return d['token']

county = login('county1'); town1 = login('town1'); town2 = login('town2')
town3 = login('town3'); grid1 = login('grid1'); grid2 = login('grid2'); grid3 = login('grid3')
acceptor = login('acceptor1'); farmer2 = login('farmer2'); team = login('team1')
cadre1 = login('cadre1'); civil1 = login('civil1')
fails = []
def check(name, cond, detail=''):
    print(('PASS' if cond else 'FAIL'), name, detail)
    if not cond: fails.append(name)

def house_by_code(code, token):
    _, d = req('GET', '/houses?q=' + code, token)
    return d['data'][0]

# ---------- B房屋：偷换材料阻断验收 ----------
b = house_by_code('NF-YL-000002', county)
arc_b = req('GET', f"/houses/{b['id']}/archive", county)[1]
plan_b = arc_b['plans'][0]
blocking = [i['type'] for i in arc_b['blockingIssues']]
check('B-偷换材料生成阻断异常', 'MATERIAL_SWAP' in blocking, str(blocking))

# 未解决材料问题前组织验收 -> 拒绝
results = [{'itemId': it['id'], 'itemType': it['type'], 'result': 'PASS'} for it in plan_b['items']]
st, d = req('POST', '/acceptances', acceptor, {'houseId': b['id'], 'itemResults': results})
check('B-阻断异常未办结禁止验收', st == 400, d.get('message', '')[:60])

# 无资质施工队不能被选择（尝试用不存在/失效队伍由乡镇创建后提交）
_, teams = req('GET', '/teams', county)[0], None
_, teamlist = req('GET', '/teams', county)
bad_team = [t for t in teamlist if not t['qualified']][0]
st, d = req('POST', '/construction-plans', farmer2, {
    'houseId': b['id'], 'teamId': bad_team['id'],
    'startDate': '2026-10-10', 'endDate': '2026-11-01',
    'budgetItems': [{'name': '防水卷材', 'spec': 'SBS 4mm', 'qty': 10, 'unit': '㎡', 'unitPrice': 45}]})
check('B-阻断异常时连提交计划也被拦截', st == 400 and '阻断' in d['message'], d.get('message', '')[:60])

# 办结材料问题（要求填写处置结果）
swap = arc_b['issues'][0]
st, d = req('POST', f"/issues/{swap['id']}/status", town2, {'status': 'RESOLVED'})
check('B-办结问题必须填处置结果', st == 400)
st, d = req('POST', f"/issues/{swap['id']}/status", town2,
            {'status': 'RESOLVED', 'resolution': '清退非标卷材，更换为SBS 4mm合格材料并复验'})
check('B-问题可办结', st == 201 or st == 200)

# 补助已批准但未销号 -> 禁止发放
sub_b = arc_b['subsidy']
st, d = req('POST', f"/subsidies/{sub_b['id']}/pay", county)
check('B-未销号禁止发补助', st == 400 and '销号' in d['message'], d.get('message', '')[:60])

# ---------- C房屋：拒绝整改/租户不搬，告知与开工制约 ----------
c = house_by_code('NF-QS-000003', county)
arc_c = req('GET', f"/houses/{c['id']}/archive", county)[1]
st, d = req('POST', '/notices', grid3, {'houseId': c['id'], 'method': '现场告知',
                                        'notifiedTo': ['户主'], 'acknowledged': False})
check('C-暂停使用房屋告知未签收被拒', st == 400 and '签收' in d['message'], d.get('message', '')[:60])
st, d = req('POST', '/construction-plans', farmer2, {
    'houseId': c['id'], 'teamId': [t for t in teamlist if t['qualified']][0]['id'],
    'startDate': '2026-10-10', 'endDate': '2026-11-10',
    'budgetItems': [{'name': '拆除', 'qty': 1, 'unit': '项', 'unitPrice': 1000}]})
check('C-阻断问题+未告知禁止开工', st == 400, d.get('message', '')[:60])

# ---------- A房屋：销号+补助已发，复查通过 ----------
a = house_by_code('NF-XK-000001', county)
arc_a = req('GET', f"/houses/{a['id']}/archive", county)[1]
check('A-状态为已销号', a['status'] == 'CLOSED')
check('A-补助已发放', arc_a['subsidy']['status'] == 'PAID')
check('A-转移人员已准许返回', arc_a['evacuations'][0]['allowReturn'] is True)
# 已发补助不能重复发放
st, d = req('POST', f"/subsidies/{arc_a['subsidy']['id']}/pay", county)
check('A-补助不可重复发放', st == 400)

# ---------- E房屋：验收不通过自动生成阻断异常 ----------
e = house_by_code('NF-XK-000005', county)
arc_e = req('GET', f"/houses/{e['id']}/archive", county)[1]
check('E-验收不通过状态', e['status'] == 'ACCEPTANCE_FAILED')
check('E-验收失败阻断异常', any(i['type'] == 'ACCEPTANCE_FAIL' and i['blocksWorkflow'] for i in arc_e['issues']))
# 未处置前再次验收 -> 拒绝
plan_e = arc_e['plans'][0]
results = [{'itemId': it['id'], 'itemType': it['type'], 'result': 'PASS'} for it in plan_e['items']]
st, d = req('POST', '/acceptances', acceptor, {'houseId': e['id'], 'itemResults': results})
check('E-阻断异常未办结不能重新验收', st == 400 and '阻断' in d['message'], d.get('message', '')[:50])

# ---------- F房屋：复查反弹后重新治理并再次销号 ----------
f = house_by_code('NF-QS-000006', county)
arc_f = req('GET', f"/houses/{f['id']}/archive", county)[1]
check('F-反弹状态', f['status'] == 'REBOUND')
# 办结反弹问题 + 重新复核
reb = [i for i in arc_f['issues'] if i['type'] == 'REBOUND'][0]
req('POST', f"/issues/{reb['id']}/status", town3, {'status': 'RESOLVED', 'resolution': '协调邻户停工，重新加固'})
insp_f = arc_f['inspections'][0]
st, d = req('POST', '/reviews', town3, {
    'inspectionId': insp_f['id'], 'decision': 'RECTIFY', 'deadline': '2026-11-20',
    'items': [
        {'type': 'REINFORCE_WALL', 'description': '新增贯通裂缝墙体加固'},
        {'type': 'SET_WARNING', 'description': '邻户施工期间设置监测警示'},
    ]})
check('F-反弹房屋允许重新复核', st in (200, 201), str(d)[:80])
plan2 = d if st in (200,201) else None
if plan2:
    req('POST', '/notices', grid3, {'houseId': f['id'], 'method': '现场告知',
                                    'notifiedTo': ['户主'], 'acknowledged': True})
    for it in plan2['items']:
        req('POST', f"/rectification-items/{it['id']}/status", town3, {'status': 'DONE'})
    results = [{'itemId': it['id'], 'itemType': it['type'], 'result': 'PASS'} for it in plan2['items']]
    st, d = req('POST', '/acceptances', acceptor, {'houseId': f['id'], 'itemResults': results, 'comment': '复验合格'})
    check('F-重新验收通过', st in (200, 201), str(d)[:80])
    st, d = req('POST', '/closes', county, {'houseId': f['id'], 'confirmedAllItems': True,
                                            'confirmedStopUseLifted': True})
    check('F-允许二次销号', st in (200, 201), str(d)[:80])

# ---------- 角色越权 ----------
st, d = req('POST', '/inspections', farmer2, {
    'township': '云岭乡', 'village': 'x', 'address': 'x', 'ownerName': 'x',
    'buildYear': 2000, 'floors': 1})
check('权限-农户不能登记巡查', st == 403)
st, d = req('POST', '/closes', town1, {'houseId': a['id'], 'confirmedAllItems': True,
                                       'confirmedStopUseLifted': True})
check('权限-乡镇不能销号', st == 403)

# ---------- 无Token ----------
st, d = req('GET', '/houses')
check('权限-未登录被拒', st == 401)

# ================= 暴雨后风险事件（feature 3） =================

# ---------- G房屋：转移级三方任务未办结禁止销号，办结后复查销号恢复等级 ----------
g = house_by_code('NF-XK-000007', county)
arc_g = req('GET', f"/houses/{g['id']}/archive", county)[1]
check('G-存在未闭环暴雨事件', len(arc_g['activeRiskEvents']) >= 1)
ev_g = arc_g['activeRiskEvents'][0]
check('G-事件为紧急转移级', ev_g['riskLevel'] == 'EVACUATE', ev_g['code'])
det_g = req('GET', f"/risk-events/{ev_g['id']}", county)[1]
depts_g = sorted(set(t['dept'] for t in det_g['dispatches']))
check('G-村干部/住建/民政三方同办', depts_g == ['CADRE', 'CIVIL', 'HOUSING'], str(depts_g))
check('G-困难家庭有民政修缮补助任务',
      any(t['dept'] == 'CIVIL' and t['kind'] == 'REPAIR_SUBSIDY' for t in det_g['dispatches']))
check('G-民政安置任务已生成转移记录且未准许返回',
      any(e['allowReturn'] is False and '应急临时安置' in (e['remark'] or '') for e in arc_g['evacuations']))

# 先逐项完工并验收通过（进入待销号），但三方任务尚未全办结
plan_g = arc_g['plans'][0]
for it in plan_g['items']:
    req('POST', f"/rectification-items/{it['id']}/status", town1, {'status': 'DONE'})
results = [{'itemId': it['id'], 'itemType': it['type'], 'result': 'PASS'} for it in plan_g['items']]
st, d = req('POST', '/acceptances', acceptor, {'houseId': g['id'], 'itemResults': results, 'comment': '加固已完成待任务闭环'})
check('G-验收通过进入待销号', st in (200, 201), str(d)[:80])

# 未完成全部处置任务前销号 -> 拒绝
st, d = req('POST', '/closes', county, {'houseId': g['id'], 'confirmedAllItems': True,
                                        'confirmedStopUseLifted': True})
check('G-三方任务未办结禁止销号', st == 400 and '处置任务' in d['message'], d.get('message', '')[:80])

# 越权：民政不能办结住建任务，外乡镇住建不能办本镇任务
housing_task = [t for t in det_g['dispatches'] if t['dept'] == 'HOUSING' and t['status'] == 'PENDING'][0]
st, d = req('POST', f"/dispatch-tasks/{housing_task['id']}/complete", civil1, {'result': '越权尝试'})
check('G-民政不能办住建任务(403)', st == 403)
st, d = req('POST', f"/dispatch-tasks/{housing_task['id']}/complete", town2, {'result': '外乡镇尝试'})
check('G-外乡镇住建不能办本镇任务(403)', st == 403)

# 办结剩余三方任务：住建两项、民政修缮补助一项
repair_task = [t for t in det_g['dispatches'] if t['kind'] == 'REPAIR_SUBSIDY' and t['status'] == 'PENDING'][0]
for t in [x for x in det_g['dispatches'] if x['dept'] == 'HOUSING' and x['status'] == 'PENDING']:
    st, _ = req('POST', f"/dispatch-tasks/{t['id']}/complete", town1, {'result': '按调整方案完成地基加固，复查结构稳定'})
    check('G-住建任务可办结', st in (200, 201))
st, _ = req('POST', f"/dispatch-tasks/{repair_task['id']}/complete", civil1,
            {'result': '困难家庭修缮救助与住建危房改造补助双线并行发放', 'amount': 30000})
check('G-民政修缮补助任务可办结并留痕金额', st in (200, 201))

# 三方任务全部办结 -> 销号（验收此前已通过）
st, d = req('POST', '/closes', county, {'houseId': g['id'], 'confirmedAllItems': True,
                                        'confirmedStopUseLifted': True, 'remark': '复查合格销号'})
check('G-任务办结后允许销号', st in (200, 201), str(d)[:80])
arc_g2 = req('GET', f"/houses/{g['id']}/archive", county)[1]
check('G-销号后事件闭环', all(e['status'] == 'CLOSED' for e in arc_g2['riskEvents']))
check('G-复查合格后风险等级恢复正常', arc_g2['house']['riskLevel'] == 'NORMAL')
check('G-销号后准许转移人员返回', all(e['allowReturn'] for e in arc_g2['evacuations']))
det_g2 = req('GET', f"/risk-events/{ev_g['id']}", county)[1]
check('G-三方任务全部办结', det_g2['allDone'] is True and det_g2['pendingCount'] == 0)

# ---------- H房屋：三天内三次上报合并一条事件，延长整改不重置状态 ----------
h = house_by_code('NF-YL-000008', county)
arc_h = req('GET', f"/houses/{h['id']}/archive", county)[1]
ev_h = [e for e in arc_h['riskEvents'] if e['status'] != 'CLOSED'][0]
check('H-三次反复上报合并为一条事件', ev_h['reportCount'] == 3, str(ev_h['reportCount']))
check('H-事件状态为延长整改', ev_h['status'] == 'EXTENDED')
merged_cnt = sum(1 for r in arc_h['rainReports'] if r['merged'])
check('H-后两次上报标记为并入', merged_cnt == 2, str(merged_cnt))
check('H-整改期限已顺延', len(arc_h['extensions']) == 1 and arc_h['extensions'][0]['newDeadline'] > arc_h['extensions'][0]['oldDeadline'])
check('H-正在整改的房屋状态未被重置', arc_h['house']['status'] == 'RECTIFYING')
# 已分流事件不可重复分流
st, d = req('POST', f"/risk-events/{ev_h['id']}/triage", town2, {'decision': 'CONTINUE'})
check('H-已分流事件不可重复分流', st == 400)
# 超过三天的再次上报仍并入同一未闭环事件（而不是新开通知）
st, d = req('POST', '/rain-reports', grid2, {
    'houseId': h['id'], 'wallCrack': 1, 'roofLeak': 2, 'foundationSettlement': 1,
    'residentsAtSite': 3, 'reportedAt': '2026-10-15T10:00:00.000Z', 'note': '事件持续，再次上报'})
check('H-跨三天再报仍并入同一事件', st in (200, 201) and d['merged'] is True and d['event']['reportCount'] == 4, str(d.get('event', {}).get('reportCount')))

# ---------- I房屋：系统筛选无需重新上门 ----------
i = house_by_code('NF-QS-000009', county)
arc_i = req('GET', f"/houses/{i['id']}/archive", county)[1]
check('I-无风险事件生成', len(arc_i.get('riskEvents', [])) == 0)
check('I-上报留痕但未归属事件', len(arc_i['rainReports']) == 1 and not arc_i['rainReports'][0]['eventId'])

# ---------- J房屋：上报即转移级，系统自动派发三方任务（无需等分流） ----------
st, ins = req('POST', '/inspections', grid1, {
    'code': 'NF-XK-000010', 'township': '溪口镇', 'village': '双溪村', 'address': '测试坡脚1号',
    'ownerName': '测试户', 'buildYear': 2010, 'floors': 1, 'residents': 1,
    'wallCrack': 1, 'roofLeak': 0, 'foundationSettlement': 0})
jh = ins['house']['id']
req('POST', '/reviews', town1, {'inspectionId': ins['inspection']['id'], 'decision': 'SUSPEND',
                                'deadline': '2026-11-30', 'items': [{'type': 'SET_WARNING', 'description': '设警示'}]})
st, d = req('POST', '/rain-reports', grid1, {
    'houseId': jh, 'wallCrack': 2, 'roofLeak': 1, 'foundationSettlement': 2,
    'residentsAtSite': 1, 'note': '坡脚房屋沉降突然加重'})
check('J-上报即升级并自动派发', st in (200, 201) and d['needVisit'] and d['dispatched'] is True, str(d.get('dispatched')))
ev_j = d['event']
det_j = req('GET', f"/risk-events/{ev_j['id']}", county)[1]
check('J-自动派发4项三方任务', len(det_j['dispatches']) == 4, str(len(det_j['dispatches'])))
# 分流确认先转移不得产生重复任务
st, d = req('POST', f"/risk-events/{ev_j['id']}/triage", town1, {'decision': 'EVACUATE', 'note': '确认先转移'})
check('J-分流先转移成功', st in (200, 201))
det_j2 = req('GET', f"/risk-events/{ev_j['id']}", county)[1]
check('J-任务不重复派发', len(det_j2['dispatches']) == 4 and det_j2['event']['status'] == 'EVACUATING')
# 转移级不允许"继续原计划"
st, d = req('POST', f"/rain-reports", grid1, {
    'houseId': jh, 'wallCrack': 2, 'foundationSettlement': 2, 'residentsAtSite': 1,
    'reportedAt': '2026-10-07T08:00:00.000Z', 'note': '次日复测'})
check('J-次日上报并入同一事件', d['merged'] is True and d['event']['reportCount'] == 2)

# ---------- 权限与视图 ----------
st, d = req('GET', f"/risk-events?houseId={jh}", town2)
check('权限-外乡镇看不到他镇事件', st == 200 and len(d['data']) == 0)
st, d = req('GET', '/dispatch-tasks/mine', civil1)
check('民政-我的任务只含民政', st == 200 and all(t['dept'] == 'CIVIL' for t in d['data']))
st, d = req('POST', '/rain-reports', farmer2, {'houseId': jh, 'foundationSettlement': 2})
check('权限-农户不能上报暴雨险情', st == 403)
st, d = req('GET', '/risk-events?active=true', county)
check('事件中心-仅未闭环事件不含已关闭G', st == 200 and not any(x['id'] == ev_g['id'] for x in d['data']))
st, d = req('GET', '/risk-events', county)
check('事件中心-全部事件含已关闭G', st == 200 and any(x['id'] == ev_g['id'] for x in d['data']))
st, d = req('GET', '/dashboard', county)
check('驾驶舱-暴雨事件统计', st == 200 and d['rain']['totalEvents'] >= 3 and 'civilAid' in d['rain'])

print()
print('FAILED:', fails if fails else 'NONE')
