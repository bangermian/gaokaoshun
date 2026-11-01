// ==UserScript==
// @name         高考顺 · 数据采集器
// @namespace    gaokaoshun
// @version      4.0.0
// @description  ① 院校线 / 专业明细（含分数、位次、录取人数）采集 ② 招生计划采集 ③ 任意网页表格抓取 → 导出高考顺模板 CSV
// @author       gaokaoshun
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * 采集路径：
 *   A. 掌上高考批量：从页面自己发出的请求里拿到已签名的 URL，只替换 year 重放，逐校抓 6 年院校线。
 *   A2. 招生计划（招生人数）：
 *       招生计划接口的签名**只有第 1 页能重放**，第 2 页往后会返回 1010800。
 *       所以改走页面本身：用 ?year=YYYY 指定年份 → 合成点击页码让页面自己请求
 *       → 直接读渲染出来的表格，把「计划招生」列求和。
 *   A3. 专业明细（重点）：
 *       /school/{id}/provinceline 这一个页面会同时请求
 *         v1/school/province_score（院校级）和 v1/school/special_score（专业级）
 *       在 document-start 挂 XHR 钩子，把两份返回原样接住；
 *       再用合成点击翻页把每页都触发出来。
 *       专业级返回里带 min / min_section / lq_num —— 最低分、最低位次、录取人数三件套，
 *       和院校级合并后就是一张「年份×省份×院校×专业」的总表。
 *   B. 通用表格：扫描当前页所有 <table>，自动识别表头并把列映射到高考顺字段，
 *      支持「分数/位次」合并在一个单元格（如 670/1301）的写法。
 *      表头含「分数 + 累计人数」时自动判定为一分一段表，导出成换算表。
 */

(function () {
  'use strict';

  /* ---------------- 网络钩子（必须最先装，赶在页面脚本之前） ---------------- */
  const GK_NET = { special: [], province: [], plan: [] };
  (function installHook() {
    try {
      window.__gkNet = GK_NET;
      const pushIfMatch = (url, json) => {
        const u = String(url || '');
        const items = (json && json.data && json.data.item) || [];
        if (!items.length) return;
        if (u.indexOf('special_score') >= 0) GK_NET.special.push(items);
        else if (u.indexOf('province_score') >= 0) GK_NET.province.push(items);
        else if (u.indexOf('special_plan') >= 0) GK_NET.plan.push(items);
      };

      const origFetch = window.fetch;
      if (origFetch) {
        window.fetch = function (...args) {
          return origFetch.apply(this, args).then((resp) => {
            try {
              const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
              if (/special_score|province_score|special_plan/.test(url)) {
                resp.clone().json().then((json) => pushIfMatch(url, json)).catch(() => {});
              }
            } catch { /* ignore */ }
            return resp;
          });
        };
      }

      const XO = window.XMLHttpRequest;
      if (XO && XO.prototype) {
        const origOpen = XO.prototype.open;
        const origSend = XO.prototype.send;
        XO.prototype.open = function (method, url, ...rest) {
          this.__gkUrl = String(url || '');
          return origOpen.call(this, method, url, ...rest);
        };
        XO.prototype.send = function (...args) {
          const self = this;
          try {
            self.addEventListener('load', function () {
              const u = self.__gkUrl || '';
              if (!/special_score|province_score|special_plan/.test(u)) return;
              try { pushIfMatch(u, JSON.parse(self.responseText)); } catch { /* ignore */ }
            });
          } catch { /* ignore */ }
          return origSend.apply(this, args);
        };
      }
    } catch { /* 钩不上就算了，后面的兜底逻辑还能用 DOM */ }
  })();

  const IS_GK = /(^|\.)gaokao\.cn$/.test(location.hostname);


  /* ============================ 配置 ============================ */

  const SCHOOLS = [[1,140,"清华大学","北京","92"],[2,31,"北京大学","北京","92"],[3,114,"浙江大学","浙江","92"],[4,125,"上海交通大学","上海","92"],[5,132,"复旦大学","上海","92"],[6,111,"南京大学","江苏","92"],[7,66,"中国科学技术大学","安徽","92"],[8,42,"武汉大学","湖北","92"],[9,127,"华中科技大学","湖北","92"],[10,330,"西安交通大学","陕西","92"],[11,47,"北京航空航天大学","北京","92"],[12,34,"哈尔滨工业大学","黑龙江","92"],[13,104,"中山大学","广东","92"],[14,143,"北京理工大学","北京","92"],[14,573,"北京协和医学院","北京","doublefirst"],[15,109,"东南大学","江苏","92"],[16,99,"四川大学","四川","92"],[17,46,"中国人民大学","北京","92"],[18,73,"同济大学","上海","92"],[19,52,"北京师范大学","北京","92"],[20,60,"天津大学","天津","92"],[21,59,"南开大学","天津","92"],[22,126,"山东大学","山东","92"],[23,107,"西北工业大学","陕西","92"],[24,557,"中国农业大学","北京","92"],[25,102,"厦门大学","福建","92"],[26,122,"吉林大学","吉林","92"],[27,123,"中南大学","湖南","92"],[28,138,"大连理工大学","辽宁","92"],[29,131,"华东师范大学","上海","92"],[30,2941,"南方科技大学","广东","doublefirst"],[31,44,"湖南大学","湖南","92"],[32,105,"华南理工大学","广东","92"],[33,661,"电子科技大学","四川","92"],[34,119,"重庆大学","重庆","92"],[35,144,"北京科技大学","北京","92"],[35,130,"上海财经大学","上海","92"],[36,112,"南京理工大学","江苏","92"],[37,77,"南京航空航天大学","江苏","92"],[37,584,"首都医科大学","北京","shuangfei"],[38,134,"东北大学","辽宁","92"],[39,57,"西安电子科技大学","陕西","92"],[39,3202,"香港中文大学（深圳）","广东","s11"],[40,97,"兰州大学","甘肃","92"],[41,38,"北京交通大学","北京","92"],[42,133,"华东理工大学","上海","92"],[42,566,"中央财经大学","北京","92"],[42,960,"南方医科大学","广东","shuangfei"],[43,124,"哈尔滨工程大学","黑龙江","92"],[44,62,"郑州大学","河南","92"],[45,417,"华中农业大学","湖北","92"],[45,168,"南京医科大学","江苏","doublefirst"],[46,118,"苏州大学","江苏","92"],[47,3151,"上海科技大学","上海","doublefirst"],[48,142,"东北师范大学","吉林","92"],[49,51,"西南交通大学","四川","92"],[50,48,"北京邮电大学","北京","92"],[51,61,"中国海洋大学","山东","92"],[52,86,"江南大学","江苏","92"],[53,420,"华中师范大学","湖北","92"],[54,128,"武汉理工大学","湖北","92"],[55,113,"南京农业大学","江苏","92"],[56,121,"中国地质大学（武汉）","湖北","92"],[56,569,"中国政法大学","北京","92"],[57,556,"北京化工大学","北京","92"],[57,53,"对外经济贸易大学","北京","92"],[57,414,"中南财经政法大学","湖北","92"],[58,115,"南京师范大学","江苏","92"],[59,106,"暨南大学","广东","92"],[60,76,"上海大学","上海","92"],[60,78,"天津医科大学","天津","92"],[61,934,"西南大学","重庆","92"],[62,832,"中国石油大学（北京）","北京","92"],[62,230,"中国医科大学","辽宁","shuangfei"],[63,116,"河海大学","江苏","92"],[63,334,"陕西师范大学","陕西","92"],[63,49,"北京中医药大学","北京","92"],[65,30,"北京工业大学","北京","92"],[65,1216,"宁波诺丁汉大学","浙江","s11"],[66,284,"深圳大学","广东","shuangfei"],[66,101,"西南财经大学","四川","92"],[67,110,"中国矿业大学","江苏","92"],[68,242,"浙江工业大学","浙江","shuangfei"],[69,332,"西北农林科技大学","陕西","92"],[69,310,"上海中医药大学","上海","doublefirst"],[70,37,"西北大学","陕西","92"],[71,35,"云南大学","云南","92"],[72,135,"东华大学","上海","92"],[73,120,"中国石油大学（华东）","山东","92"],[74,108,"南昌大学","江西","92"],[75,830,"中国地质大学（北京）","北京","92"],[76,1006,"中国矿业大学（北京）","北京","92"],[77,103,"福州大学","福建","92"],[78,240,"宁波大学","浙江","doublefirst"],[78,3039,"上海纽约大学","上海","s11"],[79,98,"华南师范大学","广东","92"],[79,45,"中央民族大学","北京","92"],[79,295,"广州医科大学","广东","doublefirst"],[79,429,"哈尔滨医科大学","黑龙江","shuangfei"],[79,39,"北京外国语大学","北京","92"],[80,63,"合肥工业大学","安徽","92"],[81,170,"江苏大学","江苏","shuangfei"],[81,229,"东北财经大学","辽宁","shuangfei"],[81,178,"重庆医科大学","重庆","shuangfei"],[81,136,"上海外国语大学","上海","92"],[82,160,"南京邮电大学","江苏","doublefirst"],[82,558,"中国传媒大学","北京","92"],[83,43,"北京林业大学","北京","92"],[84,831,"华北电力大学（北京）","北京","92"],[85,935,"贵州大学","贵州","92"],[86,96,"广西大学","广西","92"],[87,504,"海南大学","海南","92"],[88,171,"南京工业大学","江苏","shuangfei"],[88,117,"中国药科大学","江苏","92"],[89,36,"长安大学","陕西","92"],[90,473,"福建师范大学","福建","shuangfei"],[91,241,"浙江师范大学","浙江","shuangfei"],[91,251,"温州医科大学","浙江","shuangfei"],[92,58,"湖南师范大学","湖南","92"],[93,169,"南京林业大学","江苏","doublefirst"],[93,173,"扬州大学","江苏","shuangfei"],[93,162,"南京中医药大学","江苏","doublefirst"],[95,459,"河南大学","河南","doublefirst"],[95,3341,"昆山杜克大学","江苏","s11"],[96,286,"广东工业大学","广东","shuangfei"],[97,139,"太原理工大学","山西","92"],[98,166,"南京信息工程大学","江苏","doublefirst"],[98,289,"广州中医药大学","广东","doublefirst"],[99,159,"杭州电子科技大学","浙江","shuangfei"],[100,589,"首都师范大学","北京","doublefirst"],[101,67,"安徽大学","安徽","92"],[101,175,"江西财经大学","江西","shuangfei"],[101,257,"浙江工商大学","浙江","shuangfei"],[102,262,"山西大学","山西","doublefirst"],[102,1343,"西交利物浦大学","江苏","s11"],[103,287,"华南农业大学","广东","doublefirst"],[104,622,"山东师范大学","山东","shuangfei"],[105,293,"广州大学","广东","shuangfei"],[105,581,"外交学院","北京","doublefirst"],[106,307,"上海理工大学","上海","shuangfei"],[107,41,"河北工业大学","天津","92"],[108,499,"青岛大学","山东","shuangfei"],[108,3251,"深圳北理莫斯科大学","广东","s11"],[109,599,"燕山大学","河北","shuangfei"],[109,596,"河北医科大学","河北","shuangfei"],[110,342,"昆明理工大学","云南","shuangfei"],[111,349,"西安理工大学","陕西","shuangfei"],[112,243,"浙江理工大学","浙江","shuangfei"],[112,219,"大连医科大学","辽宁","shuangfei"],[113,33,"大连海事大学","辽宁","92"],[113,875,"首都经济贸易大学","北京","shuangfei"],[114,32,"内蒙古大学","内蒙古","92"],[115,419,"东北林业大学","黑龙江","92"],[116,252,"杭州师范大学","浙江","shuangfei"],[117,385,"湘潭大学","湖南","doublefirst"],[118,351,"西安建筑科技大学","陕西","shuangfei"],[119,268,"西南石油大学","四川","doublefirst"],[119,592,"北京语言大学","北京","shuangfei"],[119,323,"华东政法大学","上海","shuangfei"],[120,137,"东北农业大学","黑龙江","92"],[120,89,"天津中医药大学","天津","doublefirst"],[121,425,"湖北大学","湖北","shuangfei"],[121,264,"成都中医药大学","四川","doublefirst"],[122,468,"福建农林大学","福建","shuangfei"],[123,311,"上海师范大学","上海","shuangfei"],[123,1007,"武汉科技大学","湖北","shuangfei"],[123,72,"安徽医科大学","安徽","shuangfei"],[123,180,"西南政法大学","重庆","shuangfei"],[125,50,"辽宁大学","辽宁","92"],[126,174,"江西师范大学","江西","shuangfei"],[126,1020,"福建医科大学","福建","shuangfei"],[127,232,"成都理工大学","四川","doublefirst"],[127,250,"浙江中医药大学","浙江","shuangfei"],[128,542,"山东农业大学","山东","shuangfei"],[129,256,"温州大学","浙江","shuangfei"],[129,164,"南京财经大学","江苏","shuangfei"],[129,570,"北京工商大学","北京","shuangfei"],[129,290,"广东外语外贸大学","广东","shuangfei"],[130,54,"河北大学","河北","shuangfei"],[130,258,"浙江财经大学","浙江","shuangfei"],[131,74,"新疆大学","新疆","92"],[131,324,"上海体育大学","上海","doublefirst"],[132,357,"陕西科技大学","陕西","shuangfei"],[132,271,"山西医科大学","山西","shuangfei"],[133,80,"天津工业大学","天津","doublefirst"],[134,100,"四川农业大学","四川","92"],[135,389,"长沙理工大学","湖南","shuangfei"],[135,199,"石河子大学","新疆","92"],[135,551,"山东第一医科大学","山东","shuangfei"],[137,544,"宁夏大学","宁夏","92"],[138,379,"长春理工大学","吉林","shuangfei"],[138,3241,"广东以色列理工学院","广东","s11"],[139,465,"华侨大学","福建","shuangfei"],[139,576,"中国人民公安大学","北京","doublefirst"],[140,537,"山东科技大学","山东","shuangfei"],[141,161,"江苏科技大学","江苏","shuangfei"],[142,309,"上海海洋大学","上海","doublefirst"],[143,70,"安徽农业大学","安徽","shuangfei"],[143,535,"山东财经大学","山东","shuangfei"],[143,318,"上海对外经贸大学","上海","shuangfei"],[144,277,"中北大学","山西","shuangfei"],[145,314,"安徽师范大学","安徽","shuangfei"],[145,462,"河南农业大学","河南","shuangfei"],[147,184,"重庆邮电大学","重庆","shuangfei"],[147,787,"南通大学","江苏","shuangfei"],[149,531,"广西师范大学","广西","shuangfei"],[149,249,"浙江农林大学","浙江","shuangfei"],[151,547,"齐鲁工业大学","山东","shuangfei"],[151,247,"中国计量大学","浙江","shuangfei"],[151,3188,"温州肯恩大学","浙江","s11"],[151,530,"广西医科大学","广西","shuangfei"],[153,228,"沈阳农业大学","辽宁","shuangfei"],[154,495,"西北师范大学","甘肃","shuangfei"],[154,1275,"北师香港浸会大学","广东","s11"],[155,421,"黑龙江大学","黑龙江","shuangfei"],[156,471,"集美大学","福建","shuangfei"],[157,129,"延边大学","吉林","92"],[158,82,"天津科技大学","天津","shuangfei"],[158,158,"徐州医科大学","江苏","shuangfei"],[159,432,"武汉纺织大学","湖北","shuangfei"],[159,151,"南京审计大学","江苏","shuangfei"],[159,423,"中南民族大学","湖北","shuangfei"],[160,79,"天津师范大学","天津","shuangfei"],[161,384,"吉林农业大学","吉林","shuangfei"],[162,433,"湖北工业大学","湖北","shuangfei"],[162,225,"辽宁师范大学","辽宁","shuangfei"],[164,510,"曲阜师范大学","山东","shuangfei"],[165,156,"常州大学","江苏","shuangfei"],[166,392,"湖南农业大学","湖南","shuangfei"],[167,507,"青岛科技大学","山东","shuangfei"],[168,833,"河南师范大学","河南","shuangfei"],[168,226,"沈阳药科大学","辽宁","shuangfei"],[169,434,"武汉工程大学","湖北","shuangfei"],[169,1142,"山东中医药大学","山东","shuangfei"],[169,402,"湖南中医药大学","湖南","shuangfei"],[170,81,"天津理工大学","天津","shuangfei"],[171,313,"上海海事大学","上海","shuangfei"],[172,167,"江苏师范大学","江苏","shuangfei"],[173,283,"汕头大学","广东","shuangfei"],[174,431,"三峡大学","湖北","shuangfei"],[175,71,"济南大学","山东","shuangfei"],[175,84,"天津财经大学","天津","shuangfei"],[176,460,"河南科技大学","河南","shuangfei"],[176,1021,"福建中医药大学","福建","shuangfei"],[177,595,"河北师范大学","河北","shuangfei"],[177,866,"北京体育大学","北京","92"],[178,572,"北京建筑大学","北京","shuangfei"],[179,209,"沈阳航空航天大学","辽宁","shuangfei"],[179,873,"河南中医药大学","河南","shuangfei"],[180,68,"安徽理工大学","安徽","shuangfei"],[181,177,"南昌航空大学","江西","shuangfei"],[182,879,"北京信息科技大学","北京","shuangfei"],[183,532,"桂林电子科技大学","广西","shuangfei"],[184,428,"长江大学","湖北","shuangfei"],[184,546,"宁夏医科大学","宁夏","shuangfei"],[185,594,"国际关系学院","北京","shuangfei"],[185,376,"西北政法大学","陕西","shuangfei"],[186,352,"西安科技大学","陕西","shuangfei"],[187,509,"青岛理工大学","山东","shuangfei"],[188,317,"上海电力大学","上海","shuangfei"],[189,598,"河北农业大学","河北","shuangfei"],[189,388,"湖南科技大学","湖南","shuangfei"],[189,205,"辽宁中医药大学","辽宁","shuangfei"],[191,1018,"重庆交通大学","重庆","shuangfei"],[192,488,"兰州交通大学","甘肃","shuangfei"],[193,69,"安徽工业大学","安徽","shuangfei"],[194,463,"河南理工大学","河南","shuangfei"],[194,157,"华东交通大学","江西","shuangfei"],[194,347,"昆明医科大学","云南","shuangfei"],[196,363,"西安邮电大学","陕西","shuangfei"],[196,234,"新疆医科大学","新疆","shuangfei"],[197,540,"山东理工大学","山东","shuangfei"],[198,391,"南华大学","湖南","shuangfei"],[198,227,"沈阳工业大学","辽宁","shuangfei"],[198,344,"云南师范大学","云南","shuangfei"],[198,185,"江西中医药大学","江西","shuangfei"],[201,364,"西藏大学","西藏","92"],[202,165,"江西理工大学","江西","shuangfei"],[202,335,"安徽财经大学","安徽","shuangfei"],[203,367,"青海大学","青海","92"],[204,483,"兰州理工大学","甘肃","shuangfei"],[205,263,"西南科技大学","四川","shuangfei"],[205,437,"湖北中医药大学","湖北","shuangfei"],[206,361,"西安工业大学","陕西","shuangfei"],[207,172,"江西农业大学","江西","shuangfei"],[207,231,"西南民族大学","四川","shuangfei"],[207,274,"西南医科大学","四川","shuangfei"],[207,404,"长春中医药大学","吉林","shuangfei"],[208,393,"东北电力大学","吉林","shuangfei"],[209,265,"四川师范大学","四川","shuangfei"],[210,466,"河南工业大学","河南","shuangfei"],[210,64,"山东医药大学","山东","shuangfei"],[211,211,"大连工业大学","辽宁","shuangfei"],[211,441,"黑龙江中医药大学","黑龙江","shuangfei"],[212,517,"内蒙古农业大学","内蒙古","shuangfei"],[213,446,"东北石油大学","黑龙江","shuangfei"],[213,2614,"北京第二外国语学院","北京","shuangfei"],[214,426,"哈尔滨理工大学","黑龙江","shuangfei"],[215,179,"重庆师范大学","重庆","shuangfei"],[215,275,"山西财经大学","山西","shuangfei"],[216,244,"嘉兴大学","浙江","shuangfei"],[216,518,"遵义医科大学","贵州","shuangfei"],[216,1011,"上海政法学院","上海","shuangfei"],[217,163,"苏州科技大学","江苏","shuangfei"],[217,482,"河南医药大学","河南","shuangfei"],[218,2379,"浙大城市学院","浙江","shuangfei"],[218,1196,"安徽中医药大学","安徽","shuangfei"],[219,401,"中南林业科技大学","湖南","shuangfei"],[220,514,"贵州师范大学","贵州","shuangfei"],[220,519,"内蒙古师范大学","内蒙古","shuangfei"],[220,515,"贵州医科大学","贵州","shuangfei"],[220,553,"山东第二医科大学","山东","shuangfei"],[222,212,"沈阳建筑大学","辽宁","shuangfei"],[222,412,"吉林财经大学","吉林","shuangfei"],[222,201,"中国刑事警察学院","辽宁","shuangfei"],[223,1062,"哈尔滨师范大学","黑龙江","shuangfei"],[224,554,"烟台大学","山东","shuangfei"],[225,269,"山西农业大学","山西","shuangfei"],[226,88,"中国民航大学","天津","shuangfei"],[227,511,"海南师范大学","海南","shuangfei"],[228,491,"青岛农业大学","山东","shuangfei"],[229,176,"东华理工大学","江西","shuangfei"],[229,525,"内蒙古医科大学","内蒙古","shuangfei"],[230,354,"西安石油大学","陕西","shuangfei"],[231,607,"石家庄铁道大学","河北","shuangfei"],[232,246,"浙江科技大学","浙江","shuangfei"],[232,1073,"重庆工商大学","重庆","shuangfei"],[232,302,"广东财经大学","广东","shuangfei"],[233,565,"北京电子科技学院","北京","shuangfei"],[233,512,"海南医科大学","海南","shuangfei"],[234,253,"湖州师范大学","浙江","shuangfei"],[235,492,"甘肃农业大学","甘肃","shuangfei"],[235,1066,"浙江传媒学院","浙江","shuangfei"],[236,248,"浙江海洋大学","浙江","shuangfei"],[237,306,"佛山大学","广东","shuangfei"],[237,308,"上海工程技术大学","上海","shuangfei"],[239,561,"北方工业大学","北京","shuangfei"],[239,365,"陕西中医药大学","陕西","shuangfei"],[240,555,"鲁东大学","山东","shuangfei"],[241,2491,"成都大学","四川","shuangfei"],[241,373,"西安外国语大学","陕西","shuangfei"],[241,193,"四川外国语大学","重庆","shuangfei"],[242,315,"上海应用技术大学","上海","shuangfei"],[242,586,"北京物资学院","北京","shuangfei"],[242,1034,"广西中医药大学","广西","shuangfei"],[243,187,"重庆理工大学","重庆","shuangfei"],[244,215,"沈阳化工大学","辽宁","shuangfei"],[245,381,"长春工业大学","吉林","shuangfei"],[246,1061,"厦门理工学院","福建","shuangfei"],[246,207,"锦州医科大学","辽宁","shuangfei"],[247,291,"东莞理工学院","广东","shuangfei"],[248,336,"延安大学","陕西","shuangfei"],[249,220,"大连交通大学","辽宁","shuangfei"],[249,464,"华北水利水电大学","河南","shuangfei"],[251,528,"山东建筑大学","山东","shuangfei"],[252,189,"赣南师范大学","江西","shuangfei"],[253,358,"西安工程大学","陕西","shuangfei"],[253,56,"河北经贸大学","河北","shuangfei"],[254,55,"河北科技大学","河北","shuangfei"],[254,217,"沈阳理工大学","辽宁","shuangfei"],[254,3055,"河北中医药大学","河北","shuangfei"],[256,370,"青海师范大学","青海","shuangfei"],[256,490,"河南财经政法大学","河南","shuangfei"],[257,436,"武汉轻工大学","湖北","shuangfei"],[258,533,"桂林理工大学","广西","shuangfei"],[258,458,"郑州轻工业大学","河南","shuangfei"],[258,87,"天津外国语大学","天津","shuangfei"],[260,270,"成都信息工程大学","四川","shuangfei"],[261,508,"内蒙古工业大学","内蒙古","shuangfei"],[262,245,"西华大学","四川","shuangfei"],[262,587,"首都体育学院","北京","shuangfei"],[263,223,"辽宁石油化工大学","辽宁","shuangfei"],[263,445,"湖北经济学院","湖北","shuangfei"],[264,255,"绍兴大学","浙江","shuangfei"],[265,430,"江汉大学","湖北","shuangfei"],[266,224,"沈阳大学","辽宁","shuangfei"],[266,294,"广东医科大学","广东","shuangfei"],[266,216,"大连外国语大学","辽宁","shuangfei"],[266,610,"中国人民警察大学","河北","shuangfei"],[267,272,"山西师范大学","山西","shuangfei"],[267,407,"湖南工商大学","湖南","shuangfei"],[267,438,"湖北医药学院","湖北","shuangfei"],[268,494,"聊城大学","山东","shuangfei"],[269,597,"华北理工大学","河北","shuangfei"],[269,320,"上海立信会计金融学院","上海","shuangfei"],[270,278,"太原科技大学","山西","shuangfei"],[270,85,"天津商业大学","天津","shuangfei"],[270,2640,"浙江外国语学院","浙江","shuangfei"],[270,1352,"四川警察学院","四川","shuangfei"],[271,786,"辽宁工程技术大学","辽宁","shuangfei"],[271,266,"西华师范大学","四川","shuangfei"],[271,521,"贵州中医药大学","贵州","shuangfei"],[271,543,"广西民族大学","广西","shuangfei"],[273,146,"南京工程学院","江苏","shuangfei"],[273,520,"贵州财经大学","贵州","shuangfei"],[274,316,"安徽工程大学","安徽","shuangfei"],[275,474,"福建理工大学","福建","shuangfei"],[275,479,"郑州航空工业管理学院","河南","shuangfei"],[275,208,"大连民族大学","辽宁","shuangfei"],[276,655,"上海海关学院","上海","shuangfei"],[277,221,"沈阳师范大学","辽宁","shuangfei"],[278,254,"台州学院","浙江","shuangfei"],[279,1009,"重庆科技大学","重庆","shuangfei"],[279,213,"辽宁工业大学","辽宁","shuangfei"],[279,470,"西藏民族大学","陕西","shuangfei"],[279,516,"贵州民族大学","贵州","shuangfei"],[279,1118,"江苏警官学院","江苏","shuangfei"],[281,578,"北京农学院","北京","shuangfei"],[281,590,"北京印刷学院","北京","shuangfei"],[281,356,"云南财经大学","云南","shuangfei"],[281,448,"武汉体育学院","湖北","shuangfei"],[283,322,"安徽建筑大学","安徽","shuangfei"],[283,3281,"深圳技术大学","广东","shuangfei"],[283,1022,"蚌埠医科大学","安徽","shuangfei"],[283,202,"沈阳医学院","辽宁","shuangfei"],[285,214,"渤海大学","辽宁","shuangfei"],[285,362,"大理大学","云南","shuangfei"],[285,276,"川北医学院","四川","shuangfei"],[285,348,"云南中医药大学","云南","shuangfei"],[287,218,"大连大学","辽宁","shuangfei"],[287,1182,"苏州工学院","江苏","shuangfei"],[287,2380,"浙大宁波理工学院","浙江","shuangfei"],[287,579,"中国劳动关系学院","北京","shuangfei"],[287,919,"山西中医药大学","山西","shuangfei"],[290,343,"云南农业大学","云南","shuangfei"],[290,606,"河北地质大学","河北","shuangfei"],[290,480,"西北民族大学","甘肃","shuangfei"],[290,1139,"南京警察学院","江苏","shuangfei"],[291,602,"河北工程大学","河北","shuangfei"],[291,538,"桂林医科大学","广西","shuangfei"],[292,1189,"宁波工程学院","浙江","shuangfei"],[292,296,"广东药科大学","广东","shuangfei"],[293,398,"湖南工业大学","湖南","shuangfei"],[293,375,"西安财经大学","陕西","shuangfei"],[293,1763,"浙江警察学院","浙江","shuangfei"],[294,395,"吉林建筑大学","吉林","shuangfei"],[294,1093,"西藏藏医药大学","西藏","shuangfei"],[295,541,"南宁师范大学","广西","shuangfei"],[295,545,"北方民族大学","宁夏","shuangfei"],[296,210,"大连海洋大学","辽宁","shuangfei"],[297,477,"闽江大学","福建","shuangfei"],[298,288,"广东海洋大学","广东","shuangfei"],[299,496,"临沂大学","山东","shuangfei"],[299,444,"哈尔滨商业大学","黑龙江","shuangfei"],[299,345,"云南民族大学","云南","shuangfei"],[299,568,"中华女子学院","北京","shuangfei"],[300,580,"北京石油化工学院","北京","shuangfei"],[300,529,"内蒙古财经大学","内蒙古","shuangfei"],[300,195,"赣南医科大学","江西","shuangfei"],[301,427,"黑龙江八一农垦大学","黑龙江","shuangfei"],[301,498,"甘肃中医药大学","甘肃","shuangfei"],[302,235,"新疆师范大学","新疆","shuangfei"],[302,203,"沈阳体育学院","辽宁","shuangfei"],[303,346,"西南林业大学","云南","shuangfei"],[303,325,"皖南医科大学","安徽","shuangfei"],[304,222,"辽宁科技大学","辽宁","shuangfei"],[305,233,"新疆农业大学","新疆","shuangfei"],[305,526,"山东工商学院","山东","shuangfei"],[306,575,"北京联合大学","北京","shuangfei"],[307,1038,"重庆文理学院","重庆","shuangfei"],[308,374,"北华大学","吉林","shuangfei"],[309,476,"闽南师范大学","福建","shuangfei"],[310,396,"湖南理工大学","湖南","shuangfei"],[311,285,"五邑大学","广东","shuangfei"],[312,439,"湖北师范大学","湖北","shuangfei"],[312,260,"浙江万里学院","浙江","shuangfei"],[312,372,"青海民族大学","青海","shuangfei"],[312,501,"甘肃政法大学","甘肃","shuangfei"],[314,964,"广东技术师范大学","广东","shuangfei"],[314,505,"内蒙古科技大学","内蒙古","shuangfei"],[316,338,"合肥大学","安徽","shuangfei"],[316,600,"承德医学院","河北","shuangfei"],[317,152,"淮安大学","江苏","shuangfei"],[318,91,"天津城建大学","天津","shuangfei"],[319,1403,"无锡学院","江苏","shuangfei"],[320,481,"中原工学院","河南","shuangfei"],[321,183,"景德镇陶瓷大学","江西","shuangfei"],[321,1238,"济宁医学院","山东","shuangfei"],[322,390,"吉林师范大学","吉林","shuangfei"],[323,386,"吉首大学","湖南","shuangfei"],[324,190,"江西科技师范大学","江西","shuangfei"],[324,182,"南京体育学院","江苏","shuangfei"],[325,3483,"江苏海洋大学","江苏","shuangfei"],[325,92,"天津体育学院","天津","shuangfei"],[326,273,"四川轻化工大学","四川","shuangfei"],[327,312,"上海第二工业大学","上海","shuangfei"],[328,1029,"长沙学院","湖南","shuangfei"],[329,536,"广西科技大学","广西","shuangfei"],[330,328,"淮北师范大学","安徽","shuangfei"],[330,1086,"成都体育学院","四川","shuangfei"],[331,1064,"淮阴师范学院","江苏","shuangfei"],[332,1092,"上海电机学院","上海","shuangfei"],[333,147,"南京晓庄学院","江苏","shuangfei"],[334,154,"盐城工学院","江苏","shuangfei"],[335,1570,"贵州师范学院","贵州","shuangfei"],[336,148,"常州工学院","江苏","shuangfei"],[336,237,"新疆财经大学","新疆","shuangfei"],[337,387,"长春师范大学","吉林","shuangfei"],[337,876,"信阳师范大学","河南","shuangfei"],[337,548,"山东体育学院","山东","shuangfei"],[337,3194,"上海健康医学院","上海","shuangfei"],[337,611,"中央司法警官学院","河北","shuangfei"],[339,1090,"榆林大学","陕西","shuangfei"],[340,1024,"安庆师范大学","安徽","shuangfei"],[340,506,"内蒙古民族大学","内蒙古","shuangfei"],[340,1493,"重庆警察学院","重庆","shuangfei"],[341,435,"湖北汽车工业学院","湖北","shuangfei"],[342,371,"陕西理工大学","陕西","shuangfei"],[343,1091,"塔里木大学","新疆","shuangfei"],[343,90,"天津职业技术师范大学","天津","shuangfei"],[343,1212,"辽宁警察学院","辽宁","shuangfei"],[345,191,"长江师范学院","重庆","shuangfei"],[345,500,"兰州财经大学","甘肃","shuangfei"],[345,452,"湖北民族大学","湖北","shuangfei"],[346,2463,"湖南第一师范学院","湖南","shuangfei"],[347,150,"江苏理工学院","江苏","shuangfei"],[347,1010,"上海商学院","上海","shuangfei"],[347,3042,"北京警察学院","北京","shuangfei"],[348,867,"江西水利电力大学","江西","shuangfei"],[349,394,"长春工程学院","吉林","shuangfei"],[350,153,"盐城师范学院","江苏","shuangfei"],[351,197,"井冈山大学","江西","shuangfei"],[351,1048,"金陵科技学院","江苏","shuangfei"],[351,1031,"广东金融学院","广东","shuangfei"],[351,963,"广东警官学院","广东","shuangfei"],[353,93,"天津农学院","天津","shuangfei"],[353,2480,"仲恺农业工程学院","广东","shuangfei"],[355,1266,"铜仁学院","贵州","shuangfei"],[355,1766,"杭州医学院","浙江","shuangfei"],[356,534,"山东交通学院","山东","shuangfei"],[357,440,"黄冈师范学院","湖北","shuangfei"],[357,475,"泉州师范学院","福建","shuangfei"],[359,883,"河南科技学院","河南","shuangfei"],[360,2393,"温州理工学院","浙江","shuangfei"],[360,1265,"西安医学院","陕西","shuangfei"],[361,331,"安徽科技工程大学","安徽","shuangfei"],[361,484,"洛阳师范学院","河南","shuangfei"],[363,1049,"徐州工程学院","江苏","shuangfei"],[364,1356,"湖北第二师范学院","湖北","shuangfei"],[365,1255,"丽水学院","浙江","shuangfei"],[365,267,"中国民用航空飞行学院","四川","shuangfei"],[365,601,"河北北方学院","河北","shuangfei"],[367,300,"惠州学院","广东","shuangfei"],[367,303,"广州体育学院","广东","shuangfei"],[368,377,"长春大学","吉林","shuangfei"],[369,1071,"贵阳学院","贵州","shuangfei"],[369,1862,"厦门医学院","福建","shuangfei"],[370,2391,"湖州学院","浙江","shuangfei"],[370,2189,"哈尔滨体育学院","黑龙江","shuangfei"],[371,1041,"沈阳工程学院","辽宁","shuangfei"],[371,1430,"河南警察学院","河南","shuangfei"],[372,457,"湖北科技学院","湖北","shuangfei"],[372,461,"湖北文理学院","湖北","shuangfei"],[372,522,"黔南民族师范学院","贵州","shuangfei"],[372,1046,"广西财经学院","广西","shuangfei"],[372,2616,"内蒙古科技大学包头医学院","内蒙古","shuangfei"],[372,886,"郑州警察学院","河南","shuangfei"],[376,292,"广东石油化工学院","广东","shuangfei"],[377,1178,"洛阳理工学院","河南","shuangfei"],[378,523,"遵义师范学院","贵州","shuangfei"],[379,2604,"衢州学院","浙江","shuangfei"],[380,198,"重庆三峡科技大学","重庆","shuangfei"],[381,424,"齐齐哈尔大学","黑龙江","shuangfei"],[381,1261,"三明学院","福建","shuangfei"],[381,453,"牡丹江医科大学","黑龙江","shuangfei"],[381,454,"齐齐哈尔医学院","黑龙江","shuangfei"],[381,1033,"右江民族医学院","广西","shuangfei"],[383,282,"太原师范学院","山西","shuangfei"],[383,1279,"山东政法学院","山东","shuangfei"],[384,1023,"阜阳师范大学","安徽","shuangfei"],[385,687,"北华航天工业学院","河北","shuangfei"],[386,1082,"绵阳师范学院","四川","shuangfei"],[387,422,"佳木斯大学","黑龙江","shuangfei"],[387,1075,"成都医学院","四川","shuangfei"],[388,2869,"成都师范学院","四川","shuangfei"],[388,359,"云南警官学院","云南","shuangfei"],[389,1044,"昆明学院","云南","shuangfei"],[389,485,"周口师范学院","河南","shuangfei"],[389,1859,"福建警察学院","福建","shuangfei"],[391,299,"岭南师范学院","广东","shuangfei"],[391,478,"莆田学院","福建","shuangfei"],[391,2606,"福建江夏学院","福建","shuangfei"],[393,65,"德州学院","山东","shuangfei"],[394,450,"黑龙江科技大学","黑龙江","shuangfei"],[394,932,"攀枝花学院","四川","shuangfei"],[394,1210,"山东航空学院","山东","shuangfei"],[394,1364,"浙江水利水电学院","浙江","shuangfei"],[398,1250,"龙岩学院","福建","shuangfei"],[398,3407,"西藏农牧大学","西藏","shuangfei"],[400,1089,"曲靖师范学院","云南","shuangfei"],[402,550,"泰山学院","山东","shuangfei"],[403,552,"潍坊学院","山东","shuangfei"],[403,1985,"湖南财政经济学院","湖南","shuangfei"],[404,1258,"河北科技师范学院","河北","shuangfei"],[405,403,"湘南学院","湖南","shuangfei"],[406,406,"衡阳师范学院","湖南","shuangfei"],[406,399,"湖南工程学院","湖南","shuangfei"],[408,1083,"内江师范学院","四川","shuangfei"],[409,493,"许昌学院","河南","shuangfei"],[409,1084,"宜宾学院","四川","shuangfei"],[409,692,"河北金融学院","河北","shuangfei"],[411,2996,"贵州理工学院","贵州","shuangfei"],[412,400,"吉林化工大学","吉林","shuangfei"],[413,1241,"宁夏师范大学","宁夏","shuangfei"],[414,1801,"合肥师范学院","安徽","shuangfei"],[414,1026,"湖北理工学院","湖北","shuangfei"],[414,3149,"江苏第二师范学院","江苏","shuangfei"],[417,337,"皖西学院","安徽","shuangfei"],[417,3338,"上海公安学院","上海","shuangfei"],[418,878,"安阳师范学院","河南","shuangfei"],[418,378,"西安体育学院","陕西","shuangfei"],[419,443,"湖北工程学院","湖北","shuangfei"],[419,487,"南阳师范学院","河南","shuangfei"],[419,2548,"苏州城市学院","江苏","shuangfei"],[419,2434,"南昌医学院","江西","shuangfei"],[422,1256,"北部湾大学","广西","shuangfei"],[422,1043,"西安文理学院","陕西","shuangfei"],[422,279,"长治医学院","山西","shuangfei"],[424,2610,"广东第二师范学院","广东","shuangfei"],[425,298,"韶关学院","广东","shuangfei"],[425,2397,"嘉兴南湖学院","浙江","shuangfei"],[426,1085,"乐山师范学院","四川","shuangfei"],[426,1858,"武夷学院","福建","shuangfei"],[428,1596,"六盘水师范学院","贵州","shuangfei"],[429,489,"商丘师范学院","河南","shuangfei"],[429,628,"石家庄学院","河北","shuangfei"],[429,1606,"吉林警察学院","吉林","shuangfei"],[431,192,"宜春学院","江西","shuangfei"],[432,1246,"枣庄学院","山东","shuangfei"],[433,1489,"重庆第二师范学院","重庆","shuangfei"],[433,1027,"湖北警官学院","湖北","shuangfei"],[434,884,"黄淮学院","河南","shuangfei"],[435,1247,"滁州学院","安徽","shuangfei"],[436,416,"怀化学院","湖南","shuangfei"],[436,539,"玉林师范学院","广西","shuangfei"],[438,418,"邵阳学院","湖南","shuangfei"],[438,624,"唐山师范学院","河北","shuangfei"],[440,2889,"南昌师范学院","江西","shuangfei"],[440,961,"肇庆学院","广东","shuangfei"],[440,1986,"湖南警察学院","湖南","shuangfei"],[442,967,"广州航海学院","广东","shuangfei"],[442,880,"平顶山学院","河南","shuangfei"],[444,1323,"河南工程学院","河南","shuangfei"],[444,1102,"西安航空学院","陕西","shuangfei"],[446,769,"成都工业学院","四川","shuangfei"],[446,1095,"天水师范大学","甘肃","shuangfei"],[448,502,"河西学院","甘肃","shuangfei"],[448,1140,"南京特殊教育师范学院","江苏","shuangfei"],[450,369,"宝鸡文理学院","陕西","shuangfei"],[450,853,"南阳理工学院","河南","shuangfei"],[450,1860,"宁德师范学院","福建","shuangfei"],[450,929,"西昌学院","四川","shuangfei"],[450,1047,"吉林医药学院","吉林","shuangfei"],[450,2266,"贵州警察学院","贵州","shuangfei"],[454,1518,"河南城建学院","河南","shuangfei"],[455,449,"黑龙江工程学院","黑龙江","shuangfei"],[455,415,"湖南文理学院","湖南","shuangfei"],[457,186,"上饶师范学院","江西","shuangfei"],[458,2617,"内蒙古科技大学包头师范学院","内蒙古","shuangfei"],[458,413,"吉林体育学院","吉林","shuangfei"],[459,408,"通化师范学院","吉林","shuangfei"],[460,2093,"济宁学院","山东","shuangfei"],[460,368,"渭南师范学院","陕西","shuangfei"],[462,409,"湖南科技学院","湖南","shuangfei"],[462,815,"武汉商学院","湖北","shuangfei"],[463,1249,"海南热带海洋学院","海南","shuangfei"],[463,397,"湖南城市学院","湖南","shuangfei"],[465,2607,"齐鲁师范学院","山东","shuangfei"],[466,625,"廊坊师范学院","河北","shuangfei"],[467,350,"玉溪师范学院","云南","shuangfei"],[468,442,"牡丹江师范学院","黑龙江","shuangfei"],[469,447,"哈尔滨学院","黑龙江","shuangfei"],[470,281,"山西大同大学","山西","shuangfei"],[471,1983,"湖南工学院","湖南","shuangfei"],[472,297,"韩山师范学院","广东","shuangfei"],[473,194,"九江学院","江西","shuangfei"],[474,1134,"太原工业学院","山西","shuangfei"],[475,1170,"宿迁学院","江苏","shuangfei"],[476,1094,"陇东学院","甘肃","shuangfei"],[477,3463,"福建技术师范学院","福建","shuangfei"],[478,204,"鞍山师范学院","辽宁","shuangfei"],[479,339,"巢湖学院","安徽","shuangfei"],[480,2608,"山东青年政治学院","山东","shuangfei"],[481,341,"黄山学院","安徽","shuangfei"],[482,405,"吉林工程技术师范学院","吉林","shuangfei"],[483,691,"河北民族师范学院","河北","shuangfei"],[483,782,"四川旅游学院","四川","shuangfei"],[483,874,"江西警察学院","江西","shuangfei"],[485,2609,"山东女子学院","山东","shuangfei"],[486,3004,"山东管理学院","山东","shuangfei"],[486,366,"咸阳师范学院","陕西","shuangfei"],[488,1014,"吉林农业科技学院","吉林","shuangfei"],[489,1269,"兰州城市学院","甘肃","shuangfei"],[490,1070,"湖南人文科技学院","湖南","shuangfei"],[490,1180,"宿州学院","安徽","shuangfei"],[492,834,"安阳工学院","河南","shuangfei"],[493,1268,"凯里学院","贵州","shuangfei"],[494,1267,"安顺学院","贵州","shuangfei"],[494,1257,"长治学院","山西","shuangfei"],[496,333,"淮南师范学院","安徽","shuangfei"],[497,1259,"贺州学院","广西","shuangfei"],[498,1919,"新乡学院","河南","shuangfei"],[499,301,"嘉应学院","广东","shuangfei"],[500,1036,"伊犁师范大学","新疆","shuangfei"],[705,785,"阿坝师范学院","四川","shuangfei"],[706,1263,"安康学院","陕西","shuangfei"],[707,410,"白城师范学院","吉林","shuangfei"],[708,1252,"百色学院","广西","shuangfei"],[709,650,"保定学院","河北","shuangfei"],[710,2520,"保山学院","云南","shuangfei"],[711,1799,"蚌埠学院","安徽","shuangfei"],[712,1519,"亳州学院","安徽","shuangfei"],[713,651,"沧州师范学院","河北","shuangfei"],[714,239,"昌吉学院","新疆","shuangfei"],[715,2466,"长沙工业学院","湖南","shuangfei"],[716,1990,"长沙师范学院","湖南","shuangfei"],[717,1042,"赤峰大学","内蒙古","shuangfei"],[718,1800,"池州学院","安徽","shuangfei"],[719,353,"楚雄师范学院","云南","shuangfei"],[720,1012,"大庆师范学院","黑龙江","shuangfei"],[721,2165,"滇西科技师范学院","云南","shuangfei"],[722,3272,"滇西应用技术大学","云南","shuangfei"],[723,3271,"鄂尔多斯应用技术学院","内蒙古","shuangfei"],[724,2432,"赣东学院","江西","shuangfei"],[725,2431,"赣南科技学院","江西","shuangfei"],[726,2358,"甘肃民族师范学院","甘肃","shuangfei"],[727,1729,"广西科技师范学院","广西","shuangfei"],[728,2364,"广西民族师范学院","广西","shuangfei"],[729,3118,"广西职业师范学院","广西","shuangfei"],[730,1731,"桂林航天工业学院","广西","shuangfei"],[731,1236,"贵州工程应用技术学院","贵州","shuangfei"],[732,629,"邯郸学院","河北","shuangfei"],[733,817,"汉江师范学院","湖北","shuangfei"],[734,2855,"河北环境工程学院","河北","shuangfei"],[735,603,"河北建筑工程学院","河北","shuangfei"],[736,688,"河北水利电力学院","河北","shuangfei"],[737,1035,"河池学院","广西","shuangfei"],[738,2405,"合肥理工学院","安徽","shuangfei"],[739,1045,"黑河学院","黑龙江","shuangfei"],[740,765,"黑龙江工业学院","黑龙江","shuangfei"],[741,894,"河南工学院","河南","shuangfei"],[742,3073,"河南牧业经济学院","河南","shuangfei"],[743,627,"衡水学院","河北","shuangfei"],[744,1624,"河套学院","内蒙古","shuangfei"],[745,1264,"菏泽学院","山东","shuangfei"],[746,355,"红河学院","云南","shuangfei"],[747,1242,"呼伦贝尔学院","内蒙古","shuangfei"],[748,1505,"荆楚理工学院","湖北","shuangfei"],[749,889,"景德镇学院","江西","shuangfei"],[750,1550,"集宁师范学院","内蒙古","shuangfei"],[751,921,"晋中学院","山西","shuangfei"],[752,236,"喀什大学","新疆","shuangfei"],[753,1707,"兰州工业学院","甘肃","shuangfei"],[754,1711,"兰州文理学院","甘肃","shuangfei"],[755,188,"辽东学院","辽宁","shuangfei"],[756,1067,"辽宁科技学院","辽宁","shuangfei"],[757,1638,"吕梁学院","山西","shuangfei"],[758,888,"萍乡学院","江西","shuangfei"],[759,2158,"普洱学院","云南","shuangfei"],[760,1521,"琼台师范学院","海南","shuangfei"],[761,3005,"山东农业工程学院","山东","shuangfei"],[762,2132,"山东石油化工学院","山东","shuangfei"],[763,1262,"商洛学院","陕西","shuangfei"],[764,2327,"山西电子科技学院","山西","shuangfei"],[765,1650,"山西工程技术学院","山西","shuangfei"],[766,2325,"山西工学院","山西","shuangfei"],[767,2329,"山西科技学院","山西","shuangfei"],[768,3064,"山西能源学院","山西","shuangfei"],[769,2815,"陕西学前师范学院","陕西","shuangfei"],[770,2392,"绍兴理工学院","浙江","shuangfei"],[771,784,"四川民族学院","四川","shuangfei"],[772,798,"四川文理学院","四川","shuangfei"],[773,1063,"绥化学院","黑龙江","shuangfei"],[774,1642,"太原学院","山西","shuangfei"],[775,3094,"泰州学院","江苏","shuangfei"],[776,608,"唐山学院","河北","shuangfei"],[777,858,"天津中德应用技术大学","天津","shuangfei"],[778,2521,"文山学院","云南","shuangfei"],[779,1251,"梧州学院","广西","shuangfei"],[780,609,"邢台学院","河北","shuangfei"],[781,2566,"兴义民族师范学院","贵州","shuangfei"],[782,2066,"新疆工程学院","新疆","shuangfei"],[783,2487,"新疆理工学院","新疆","shuangfei"],[784,2631,"新疆政法学院","新疆","shuangfei"],[785,1203,"信阳农林学院","河南","shuangfei"],[786,891,"新余学院","江西","shuangfei"],[787,280,"忻州师范学院","山西","shuangfei"],[788,3061,"营口理工学院","辽宁","shuangfei"],[789,920,"运城学院","山西","shuangfei"],[790,872,"豫章师范学院","江西","shuangfei"],[791,2902,"张家口学院","河北","shuangfei"],[792,2157,"昭通学院","云南","shuangfei"],[793,1922,"郑州工程技术学院","河南","shuangfei"],[794,1147,"郑州师范学院","河南","shuangfei"],[795,1861,"福建商学院","福建","shuangfei"],[796,1732,"桂林旅游学院","广西","shuangfei"],[797,1564,"贵州商学院","贵州","shuangfei"],[798,711,"哈尔滨金融学院","黑龙江","shuangfei"],[799,1920,"河南财政金融学院","河南","shuangfei"],[800,1604,"吉林工商学院","吉林","shuangfei"],[801,340,"铜陵学院","安徽","shuangfei"],[802,2489,"新疆科技学院","新疆","shuangfei"],[803,2316,"呼和浩特民族学院","内蒙古","shuangfei"],[804,626,"河北体育学院","河北","shuangfei"],[805,3627,"河南体育学院","河南","shuangfei"],[806,1705,"甘肃医学院","甘肃","shuangfei"],[807,1987,"湖南医药学院","湖南","shuangfei"],[808,1152,"山西医药学院","山西","shuangfei"],[809,2490,"新疆第二医学院","新疆","shuangfei"],[810,1995,"湖南女子学院","湖南","shuangfei"],[811,1734,"广西警察学院","广西","shuangfei"],[812,1204,"山东警察学院","山东","shuangfei"],[813,1640,"山西警察学院","山西","shuangfei"],[814,2068,"新疆警察学院","新疆","shuangfei"]];
  const PROVINCES = [
    ['北京', 11], ['天津', 12], ['河北', 13], ['山西', 14], ['内蒙古', 15],
    ['辽宁', 21], ['吉林', 22], ['黑龙江', 23], ['上海', 31], ['江苏', 32],
    ['浙江', 33], ['安徽', 34], ['福建', 35], ['江西', 36], ['山东', 37],
    ['河南', 41], ['湖北', 42], ['湖南', 43], ['广东', 44], ['广西', 45],
    ['海南', 46], ['重庆', 50], ['四川', 51], ['贵州', 52], ['云南', 53],
    ['西藏', 54], ['陕西', 61], ['甘肃', 62], ['青海', 63], ['宁夏', 64], ['新疆', 65],
  ];

  const YEARS = ['2026', '2025', '2024', '2023', '2022', '2021'];

  /*
   * 分片（并发标签页）机制
   *   主标签页把任务切成 N 份，用 window.open 开 N-1 个子标签页，URL 上带 #gk-shard=i。
   *   子标签页把 shard 号记进 sessionStorage（跳转时会丢 hash，但 sessionStorage 跟标签页走），
   *   然后用**自己独立的 state 键**读写，互不覆盖。
   *   导出时把所有分片合并。
   */
  const SHARD_PLAN_KEY = 'gaokaoshun.shardplan.v1';
  const readShardId = () => {
    try {
      // 站点路由会把 URL 的 hash 和自定义查询参数都抹掉，window.name 也会被重置，
      // 所以分片号只能靠「当前页面的 校+年」去主标签页留下的计划里对号入座。
      const saved0 = sessionStorage.getItem('gkShard');
      if (saved0 != null) return Number(saved0);

      let plan = null;
      try { plan = JSON.parse(localStorage.getItem(SHARD_PLAN_KEY) || 'null'); } catch { plan = null; }
      if (plan?.starts?.length) {
        const id = (/\/school\/(\d+)/.exec(location.pathname) || [])[1];
        const year = new URL(location.href).searchParams.get('year');
        const hit = plan.starts.find((s) => s.shard !== 0
          && String(s.id) === String(id) && String(s.year) === String(year));
        if (hit) { sessionStorage.setItem('gkShard', String(hit.shard)); return hit.shard; }
      }
      return null;
    } catch { return null; }
  };
  const SHARD = readShardId();
  const stateKeyFor = (shard) => (shard == null ? 'gaokaoshun.state.v2' : `gaokaoshun.state.shard${shard}.v2`);

  const STATE_KEY = stateKeyFor(SHARD);
  const MAP_KEY = 'gaokaoshun.mapping.v1';
  const CAPTURE_TIMEOUT = 15000;
  const BETWEEN_SCHOOLS = 2500;

  /** 当前名次区间内的学校（含并列：名次落在区间里就算） */
  function selectedSchools() {
    const from = Math.min(state.rankFrom, state.rankTo);
    const to = Math.max(state.rankFrom, state.rankTo);
    return SCHOOLS.filter((s) => s[0] >= from && s[0] <= to);
  }

  /** 最近 N 年（YEARS 已按从新到旧排好） */
  function selectedYears() {
    return YEARS.slice(0, Math.min(6, Math.max(1, state.yearCount)));
  }

  const FIELDS = [
    ['year', '年份'],
    ['province', '招生省份'],
    ['school', '院校名称'],
    ['location', '院校所在地'],
    ['major', '专业名称'],
    ['highScore', '最高分'],
    ['lowScore', '最低分'],
    ['highRank', '最高位次'],
    ['lowRank', '最低位次'],
    ['volume', '录取人数'],
    ['score', '分数(一分一段)'],
    ['cumulative', '累计人数'],
  ];

  const HEADER_RULES = [
    ['year', /^年份$|^年度$/],
    ['school', /院校|学校/],
    ['major', /专业/],
    ['province', /^省份$|招生省份|生源省/],
    ['location', /所在地|城市/],
    ['cumulative', /累计/],
    ['score', /^分数$|^成绩$/],
    ['highScore', /最高分/],
    ['lowScore', /最低分|投档线|^分数/],
    ['highRank', /最高位次|最高排名/],
    ['lowRank', /最低位次|位次|排名/],
    ['volume', /人数|计划/],
  ];

  /* ============================ 状态 ============================ */

  let state = loadState();
  state.rows = state.rows || {};
  state.queue = state.queue || [];
  state.index = state.index || 0;
  state.running = Boolean(state.running);
  state.province = state.province || '天津';
  state.log = state.log || [];
  state.scores = state.scores || [];      // 通用表格抓到的分数行
  state.segments = state.segments || [];  // 一分一段行
  // 招生计划采集：{ running, queue:[{id,year}], index, results:{ id:{name,years:{年份:{total,rows,majors}}} } }
  state.plan = state.plan || { running: false, queue: [], index: 0, results: {} };
  // 专业明细采集：{ running, queue, index, rows:{ 'id|年份': {majors, school, ...} } }
  state.detail = state.detail || { running: false, queue: [], index: 0, rows: {} };
  // 一分一段采集结果：{ rows: [{year,province,score,cumulative}], province, at }
  state.segFetch = state.segFetch || { rows: [] };
  // 续跑相关：默认跳过已抓过的「校×年」；失败清单可一键重试
  if (state.skipDone == null) state.skipDone = true;
  if (!Array.isArray(state.detail?.failed)) state.detail.failed = [];
  // 采集范围：名次区间 + 最近几年（默认 1–100 名、最近 6 年）
  state.rankFrom = Number(state.rankFrom) || 1;
  state.rankTo = Number(state.rankTo) || 100;
  state.yearCount = Math.min(6, Math.max(1, Number(state.yearCount) || 6));

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; } catch { return {}; }
  }
  function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* 配额满了也不影响抓取 */ }
  }
  function log(message) {
    state.log.unshift(`[${new Date().toLocaleTimeString('zh-CN')}] ${message}`);
    state.log = state.log.slice(0, 40);
    saveState();
    render();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout = 10000, interval = 300) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  /* ============================ A. 掌上高考批量 ============================ */

  const schoolById = new Map(SCHOOLS.map((s) => [String(s[1]), s]));
  const currentSchoolId = () => (/\/school\/(\d+)/.exec(location.pathname) || [])[1] || null;

  function findSignedUrl(part) {
    const urls = performance.getEntriesByType('resource').map((r) => r.name)
      .filter((n) => n.includes(part) && n.includes('signsafe='));
    return urls.length ? urls[urls.length - 1] : null;
  }

  function clickHistoryTab() {
    const hit = [...document.querySelectorAll('a,div,span,li')]
      .find((el) => (el.textContent || '').trim() === '历年分数' && el.offsetParent !== null);
    if (hit) hit.click();
    return Boolean(hit);
  }

  async function fetchYears(signedUrl, years) {
    const params = Object.fromEntries(new URL(signedUrl).searchParams);
    const out = {};
    for (const year of years) {
      const url = signedUrl.replace(/year=\d{4}/, `year=${year}`);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...params, year }),
        });
        const json = await res.json();
        const items = (json?.data?.item ?? []).filter((it) => it.min && it.min !== '-');
        if (json.code === 0 && items.length > 0) {
          const isRegular = (it) => /本科批/.test(it.local_batch_name || '')
            && !/提前|专项|民族|中外/.test(it.local_batch_name || '');
          const isCommon = (it) => (it.zslx_name || '').includes('普通');
          const hit = items.find((it) => isRegular(it) && isCommon(it))
            ?? items.find(isRegular) ?? items.find(isCommon) ?? items[0];
          out[year] = {
            min: hit.min ?? '',
            rank: hit.min_section && hit.min_section !== '-' ? hit.min_section : '',
            batch: hit.local_batch_name ?? '',
          };
        }
      } catch { /* 单年失败不影响其它年份 */ }
      await sleep(260);
    }
    return out;
  }

  async function collectCurrentSchool() {
    const id = currentSchoolId();
    if (!id) return { ok: false, reason: '当前不在院校页' };
    if (!document.querySelector('table.tb-normal')) {
      clickHistoryTab();
      await sleep(1500);
    }
    const signed = await waitFor(() => findSignedUrl('province_score') || findSignedUrl('special_score'), CAPTURE_TIMEOUT);
    if (!signed) return { ok: false, reason: '没捕获到分数线请求（页面可能没加载完）' };

    const years = await fetchYears(signed, selectedYears());
    if (!Object.keys(years).length) return { ok: false, reason: '接口没返回任何年份数据' };

    const meta = schoolById.get(id);
    const name = meta ? meta[2] : (document.title.split('—')[0].trim() || `学校${id}`);
    state.rows[id] = {
      name,
      location: meta ? meta[3] : '',
      plate: meta ? meta[4] : 'shuangfei',
      years,
    };
    saveState();
    return { ok: true, name, years: Object.keys(years).length, ranks: Object.values(years).filter((y) => y.rank).length };
  }

  function applyProvince() {
    const entry = PROVINCES.find(([name]) => name === state.province);
    if (!entry) return;
    localStorage.setItem('localprovinceid', String(entry[1]));
    localStorage.setItem('localprovincename', entry[0]);
  }

  async function runIfBatch() {
    if (!state.running || !IS_GK) return;
    const id = currentSchoolId();
    if (!id || String(state.queue[state.index]) !== String(id)) return;

    const result = await collectCurrentSchool();
    log(result.ok ? `✓ ${result.name}：${result.years} 年（${result.ranks} 年有位次）` : `✗ ${id}：${result.reason}`);

    state.index += 1;
    saveState();
    if (state.index >= state.queue.length) {
      state.running = false;
      saveState();
      log(`全部完成：${Object.keys(state.rows).length} 所`);
      return;
    }
    await sleep(BETWEEN_SCHOOLS);
    location.href = `https://www.gaokao.cn/school/${state.queue[state.index]}/special`;
  }

  /* ============================ A2. 招生计划 ============================ */
  /*
   * 为什么不用重放接口：
   *   招生计划接口第 2 页往后的签名重放会被拒（code 1010800），只有第 1 页能重放。
   *   但页面自己是能发请求的——所以改成：
   *     1) 用 ?year=YYYY 直接指定年份（实测有效，下拉框也跟着变）
   *     2) 合成点击页码，让页面自己请求下一页
   *     3) 直接读渲染出来的表格，把「计划招生」列求和
   *   这样既不碰签名，也不依赖登录以外的任何权限。
   */

  const PLAN_YEARS = ['2026', '2025', '2024', '2023', '2022', '2021'];
  const PLAN_GAP = 1200;

  const planResults = () => state.plan.results || (state.plan.results = {});
  const planUrl = (id, year) => `https://www.gaokao.cn/school/${id}/sturule?year=${year}`;

  function startPlanQueue(ids, years) {
    const queue = [];
    for (const id of ids) for (const year of years) queue.push({ id: String(id), year: String(year) });
    state.plan.queue = queue;
    state.plan.index = 0;
    state.plan.running = true;
    saveState();
    gotoPlanTask();
  }

  function stopPlanQueue() {
    state.plan.running = false;
    saveState();
    render();
  }

  function gotoPlanTask() {
    const task = state.plan.queue[state.plan.index];
    if (!task) {
      state.plan.running = false;
      saveState();
      render();
      log(`招生计划采集完成：${Object.keys(planResults()).length} 所`);
      return;
    }
    location.href = planUrl(task.id, task.year);
  }

  const planTable = () => [...document.querySelectorAll('table')]
    .find((t) => (t.innerText || '').includes('专业名称'));

  /** 读当前页的「计划招生」列 */
  function readPlanPage() {
    const table = planTable();
    if (!table) return null;
    const headCells = [...(table.querySelector('tr')?.children || [])].map((td) => (td.innerText || '').trim());
    let col = headCells.findIndex((h) => /计划/.test(h));
    if (col < 0) col = 1;

    const trs = [...table.querySelectorAll('tr')].slice(1);
    let sum = 0;
    let parsed = 0;
    const majors = [];
    for (const tr of trs) {
      const cells = [...tr.children].map((td) => (td.innerText || '').replace(/\s+/g, ' ').trim());
      const num = parseInt(String(cells[col] ?? '').replace(/[^0-9]/g, ''), 10);
      if (!Number.isFinite(num)) continue;
      sum += num;
      parsed += 1;
      majors.push({ name: cells[0] || '', plan: num });
    }
    return { rows: trs.length, parsed, sum, majors };
  }

  /** 合成点击页码（实测能触发页面自己发请求） */
  function clickPlanPage(n) {
    const li = [...document.querySelectorAll('.ant-pagination-item')]
      .find((x) => (x.textContent || '').trim() === String(n));
    if (!li) return false;
    const a = li.querySelector('a') || li;
    a.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    a.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }

  const planRequestCount = () => performance.getEntriesByType('resource')
    .filter((r) => r.name.includes('special_plan')).length;

  /** 把当前页（含翻页）的所有专业计划加总 */
  async function collectPlanOnPage() {
    const ready = await waitFor(() => document.querySelectorAll('table tr').length > 1, 15000, 300);
    if (!ready) return { total: 0, rows: 0, majors: [] };

    await waitFor(() => pageNumbers().length > 0, 4000, 150);

    let total = 0;
    let rows = 0;
    const majors = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard += 1) {
      const data = readPlanPage();
      if (!data) break;
      total += data.sum;
      rows += data.parsed;
      majors.push(...data.majors);

      // 不能靠"行数不满一页"判断结尾：有的表每页只有 8 行，会一刀切掉后面所有页。
      // 改成点下一页、看有没有触发新请求。
      const nums = pageNumbers();
      const maxPage = nums.length ? Math.max(...nums) : 1;
      if (page >= maxPage) break;

      const before = planRequestCount();
      if (!clickPlanPage(page + 1)) break;
      const grew = await waitFor(() => planRequestCount() > before, 6000, 150);
      if (!grew) break;
      page += 1;
      await sleep(150);
    }
    return { total, rows, majors };
  }

  /** 页面加载后，如果队头正是当前页，就采这一条并前进 */
  async function runPlanTaskIfNeeded() {
    if (!state.plan.running || !IS_GK) return;
    if (!/\/sturule/.test(location.pathname)) return;

    const task = state.plan.queue[state.plan.index];
    if (!task) { state.plan.running = false; saveState(); render(); return; }

    const id = currentSchoolId();
    const urlYear = new URL(location.href).searchParams.get('year');
    if (String(id) !== String(task.id) || String(urlYear) !== String(task.year)) return;

    const meta = schoolById.get(String(task.id));
    const name = meta ? meta[2] : `学校${task.id}`;
    log(`采集中：${name} ${task.year}`);

    const data = await collectPlanOnPage();
    const results = planResults();
    results[String(task.id)] = results[String(task.id)] || { name, years: {} };
    results[String(task.id)].years[task.year] = data;

    state.plan.index += 1;
    saveState();
    render();
    log(`${name} ${task.year}：${data.total} 人 / ${data.rows} 条`);

    await sleep(PLAN_GAP);
    gotoPlanTask();
  }

  function buildPlanCsv(detail = false) {
    const lines = [];
    if (detail) {
      lines.push('院校ID,院校名称,年份,专业名称,计划人数');
      for (const [id, item] of Object.entries(planResults())) {
        for (const year of Object.keys(item.years).sort()) {
          for (const m of item.years[year].majors || []) {
            lines.push([id, item.name, year, `"${String(m.name).replace(/"/g, '""')}"`, m.plan].join(','));
          }
        }
      }
    } else {
      lines.push('院校ID,院校名称,年份,计划人数,专业条数');
      for (const [id, item] of Object.entries(planResults())) {
        for (const year of Object.keys(item.years).sort()) {
          const y = item.years[year];
          lines.push([id, item.name, year, y.total, y.rows].join(','));
        }
      }
    }
    return lines.join('\r\n');
  }

  /* ============================ A3. 专业明细 ============================ */
  /*
   * /school/{id}/provinceline 一次会请求两个接口：
   *   province_score → 院校级（批次/类型/最低分/最低位次）
   *   special_score  → 专业级（专业/最低分/最低位次/录取人数/专业组/选科）
   * 钩子在 document-start 就装好了，所以这里只要"把每一页都点出来"即可。
   */

  const DETAIL_GAP = 400;      // 两所学校之间只歇 0.4s，整体快一倍多

  const detailStore = () => state.detail.rows || (state.detail.rows = {});
  const provincelineUrl = (id, year) => `https://www.gaokao.cn/school/${id}/provinceline?year=${year}`;

  function startDetailQueue(ids, years) {
    try {
      const queue = [];
      // phase: 'detail' 抓分数线；缺人数时会插入一条 phase:'plan' 补计划数
      // 已抓过的「校×年」默认跳过：换区间续跑时不会重复消耗请求
      const skipDone = state.skipDone !== false;
      let skippedDone = 0;
      for (const id of ids) {
        for (const year of years) {
          const key = `${id}|${year}`;
          if (skipDone && detailStore()[key]) { skippedDone += 1; continue; }
          queue.push({ id: String(id), year: String(year), phase: 'detail' });
        }
      }
      if (skippedDone > 0) log(`跳过已抓过的 ${skippedDone} 个「校×年」`);
      if (queue.length === 0) {
        log('该范围内都已抓过，没有新任务。想重抓请取消勾选「跳过已抓过的」');
        return;
      }

      // 并发分片实测走不通，已退回单页：
      //   · 站点路由会抹掉 URL 的 hash 和自定义查询参数，window.name 也会被重置，
      //     分片号传不过去（尝试过三种载体）
      //   · 更要命的是 Chrome 会节流/冻结后台标签页的定时器：
      //     新开标签页抢到焦点后，主标签页的等待循环直接停摆，队列卡死
      // 单页串行 + 前面那轮提速（翻页改批量点、间隔缩短）已经是稳妥上限。
      state.detail.queue = queue;

      state.detail.index = 0;
      state.detail.running = true;
      saveState();
      gotoDetailTask();
    } catch (e) {
      window.__sdErr = `${e && e.message}\n${(e && e.stack) || ''}`;
      throw e;
    }
  }

  function stopDetailQueue() {
    state.detail.running = false;
    saveState();
    render();
  }

  function gotoDetailTask() {
    const task = state.detail.queue[state.detail.index];
    if (!task) {
      state.detail.running = false;
      saveState();
      render();
      log(`专业明细采集完成：${Object.keys(detailStore()).length} 个「院校×年份」`);
      return;
    }
    // 一条任务两段：先抓分数线（detail），缺人数的年份再补一趟招生计划（plan）
    const next = task.phase === 'plan'
      ? `https://www.gaokao.cn/school/${task.id}/sturule?year=${task.year}`
      : provincelineUrl(task.id, task.year);
    log(`跳转 ${task.id} ${task.year}${task.phase === 'plan' ? '（补计划数）' : ''}`);
    // 用 assign 而不是给 href 赋值：个别页面会给 location.href 装 setter，
    // 直接赋值可能被静默吞掉（这次就踩到了，表现是"点了没反应"）。
    try { window.location.assign(next); } catch { window.location.href = next; }
  }

  /**
   * 用招生计划里的「计划招生」补上缺失的录取人数。
   * 站点只对 2024/2025 公布专业级录取人数，2021–2023 大量是 "-"，
   * 但招生计划页每年都有计划数，按专业名对得上就能补。
   */
  function mergePlanIntoDetail(schoolId, year, planMajors) {
    const rec = detailStore()[`${schoolId}|${year}`];
    if (!rec || !planMajors?.length) return 0;

    // 招生计划的专业名末尾多一段「选科要求：物理必选」，分数线那边没有，
    // 不剥掉就一条都对不上（实际踩到过：补上 0 个人数）
    const norm = (s) => String(s || '')
      .replace(/选科要求[：:][^）)]*$/g, '')
      .replace(/[\s\u3000]+/g, '');
    const main = (s) => norm(s).replace(/[（(].*$/, '');

    // 两边都按「大类」聚合了：分数线那边是 专业名 去掉括号，
    // 招生计划这边同样归并，同大类的计划数相加后再补。
    const byMain = new Map();
    for (const p of planMajors) {
      const key = main(p.name);
      byMain.set(key, (byMain.get(key) || 0) + (Number(p.plan) || 0));
    }

    let filled = 0;
    for (const mj of rec.majors) {
      if (mj.volume != null) continue;              // 已有真实录取人数，不动
      const key = main(mj.major);
      const plan = byMain.get(key);
      if (plan > 0) {
        mj.volume = plan;
        mj.volumeFrom = 'plan';
        filled += 1;
      }
    }
    return filled;
  }

  /** 把钩子收到的原始条目去重、按「专业大类」合并整理 */
  function collectCaptured() {
    /*
     * 站点会把同一个专业拆成多条：机器人工程（荣誉项目班）和 机器人工程（荣誉项目班；校本部）
     * 其实是同一个专业的不同班型/校区。按用户口径：专业名只取「（」之前的部分，
     * 同一大类的多条合并——人数相加、最低分取最低、最低位次取最大（最差）。
     */
    const baseName = (s) => String(s || '').split(/[（(]/)[0].trim() || '（未命名专业）';

    const groups = new Map();
    for (const items of GK_NET.special) {
      for (const it of items) {
        const name = baseName(it.sp_name);
        const min = it.min && it.min !== '-' ? Number(it.min) : null;
        const max = it.max && it.max !== '-' ? Number(it.max) : null;
        const rank = it.min_section && it.min_section !== '-' ? Number(it.min_section) : null;
        // lq_num 是「录取人数」，站点只对部分年份公布，"-" 必须留空（写 0 会误导）
        const lq = it.lq_num && it.lq_num !== '-' ? Number(it.lq_num) : null;

        let g = groups.get(name);
        if (!g) {
          g = {
            major: name, minScore: null, maxScore: null, minRank: null,
            volume: null, hasVolume: false, groups: new Set(), xuanke: new Set(), variants: 0,
          };
          groups.set(name, g);
        }
        g.variants += 1;
        if (min != null) g.minScore = g.minScore == null ? min : Math.min(g.minScore, min);
        if (max != null) g.maxScore = g.maxScore == null ? max : Math.max(g.maxScore, max);
        if (rank != null) g.minRank = g.minRank == null ? rank : Math.max(g.minRank, rank);
        if (lq != null) { g.volume = (g.volume || 0) + lq; g.hasVolume = true; }
        if (it.sg_name) g.groups.add(it.sg_name);
        if (it.sg_info) g.xuanke.add(it.sg_info);
      }
    }

    const majors = [...groups.values()].map((g) => ({
      major: g.major,
      minScore: g.minScore,
      maxScore: g.maxScore,
      minRank: g.minRank,
      maxRank: null,
      volume: g.hasVolume ? g.volume : null,
      group: [...g.groups].join(' '),
      xuanke: [...g.xuanke].join(' / '),
      variants: g.variants,
    }));

    const seenSchool = new Set();
    const school = [];
    for (const items of GK_NET.province) {
      for (const it of items) {
        const key = `${it.local_batch_name}|${it.zslx_name}|${it.min}|${it.min_section}`;
        if (seenSchool.has(key)) continue;
        seenSchool.add(key);
        school.push({
          batch: it.local_batch_name || '',
          type: it.zslx_name || '',
          minScore: it.min && it.min !== '-' ? Number(it.min) : null,
          maxScore: it.max && it.max !== '-' ? Number(it.max) : null,
          minRank: it.min_section && it.min_section !== '-' ? Number(it.min_section) : null,
        });
      }
    }
    return { majors, school };
  }

  const pageNumbers = () => [...document.querySelectorAll('.ant-pagination-item')]
    .map((x) => Number((x.textContent || '').trim())).filter(Number.isFinite);

  /** 在当前页把分页点完，把数据都钩下来 */
  async function collectDetailOnPage() {
    const first = await waitFor(
      () => GK_NET.special.length > 0 || GK_NET.province.length > 0,
      15000, 150,
    );
    if (!first) return null;

    // 分页器是数据回来之后才渲染的，必须等它出现，
    // 否则 pageNumbers() 为空 → maxPage 算成 1 → 后面几页全丢（这个坑踩过一次）
    await waitFor(() => pageNumbers().length > 0, 4000, 150);

    let page = 1;
    const nums0 = pageNumbers();
    const maxPage0 = nums0.length ? Math.max(...nums0) : 1;
    log(`明细翻页：页码 ${JSON.stringify(nums0)}，已收 ${GK_NET.special.length} 组`);

    // 连点所有页，不再"一页一等"——每等一轮光等网络就要 2–4 秒。
    // 点完再统一等"数量不再增长"，把 N 次串行等待压成一次。
    for (let p = 2; p <= maxPage0; p += 1) {
      if (!clickPlanPage(p)) break;
      page = p;
      await sleep(350);
    }

    // 等稳定：连续两轮数量不变就算完（最多等 6 秒）
    let last = -1;
    for (let i = 0; i < 24; i += 1) {
      await sleep(250);
      if (GK_NET.special.length === last && GK_NET.special.length > 0) break;
      last = GK_NET.special.length;
    }
    log(`明细翻页结束：到第 ${page} 页，共 ${GK_NET.special.length} 组`);
    return collectCaptured();
  }

  /**
   * 子标签页：从主标签页留下的分片计划里认领自己那份，然后开跑。
   * 分片号来自 URL 的 #gk-shard=i，之后靠 sessionStorage 记住（跳转会丢 hash）。
   */
  function adoptShardIfNeeded() {
    if (SHARD == null) return false;
    if (state.detail?.running) return false;

    let plan = null;
    try { plan = JSON.parse(localStorage.getItem(SHARD_PLAN_KEY) || 'null'); } catch { plan = null; }
    const tasks = plan?.shards?.[SHARD];
    if (!tasks?.length) return false;

    state.detail = { running: true, queue: tasks, index: 0, rows: {} };
    saveState();
    log(`子标签页 ${SHARD}：认领 ${tasks.length} 条任务`);

    const first = tasks[0];
    const id = currentSchoolId();
    const y = new URL(location.href).searchParams.get('year');
    if (String(id) !== String(first.id) || String(y) !== String(first.year)) gotoDetailTask();
    return true;
  }

  /** 队头命中当前页就采，然后跳到下一条 */
  async function runDetailTaskIfNeeded() {
    if (!state.detail.running || !IS_GK) return;

    const task = state.detail.queue[state.detail.index];
    if (!task) { state.detail.running = false; saveState(); render(); return; }

    const isPlanPhase = task.phase === 'plan';
    const wantPath = isPlanPhase ? /\/sturule/ : /\/provinceline/;
    if (!wantPath.test(location.pathname)) return;

    const id = currentSchoolId();
    const urlYear = new URL(location.href).searchParams.get('year');
    if (String(id) !== String(task.id) || String(urlYear) !== String(task.year)) return;

    const meta = schoolById.get(String(task.id));
    const name = meta ? meta[2] : `学校${task.id}`;

    if (isPlanPhase) {
      // 第二段：抓招生计划，把缺失的录取人数补上
      const plan = await collectPlanOnPage();
      const filled = mergePlanIntoDetail(task.id, task.year, plan?.majors ?? []);
      log(`${name} ${task.year}：计划表 ${plan?.majors?.length ?? 0} 条专业，补上 ${filled} 个人数`);
      state.detail.index += 1;
      saveState();
      render();
      await sleep(DETAIL_GAP);
      gotoDetailTask();
      return;
    }

    log(`明细采集中：${name} ${task.year}`);

    // 注意：不要在这里清空 GK_NET —— 每次跳转都是新文档，缓冲区本来就是空的；
    // 而页面的首屏请求可能比 boot 更早完成，清空会把刚到手的首屏数据抹掉。
    const data = await collectDetailOnPage();
    if (data) {
      detailStore()[`${task.id}|${task.year}`] = {
        id: task.id,
        name,
        location: meta ? meta[3] : '',
        plate: meta ? meta[4] : '',
        year: task.year,
        province: state.province,
        majors: data.majors,
        school: data.school,
      };
      const missing = data.majors.filter((m) => m.volume == null).length;
      log(`${name} ${task.year}：${data.majors.length} 个专业 / ${data.school.length} 条院校线${missing ? `（${missing} 个缺人数）` : ''}`);

      // 缺人数就插一条「补计划」任务，紧跟在这一条后面
      if (missing > 0) {
        state.detail.queue.splice(state.detail.index + 1, 0, {
          id: task.id, year: task.year, phase: 'plan',
        });
      }
    } else {
      log(`${name} ${task.year}：没抓到数据（可能该年未公布）`);
    }

    // 空结果不能当成"已完成"直接跳过 —— 被限流时页面拿不到任何数据，
    // 一路跳过去会把后面几十所学校全部记成"已采"，导出的表就断了（实际踩过：
    // 天津只抓到第 81 名，后面全空）。所以连续空就暂停重试。
    const got = data?.majors?.length ?? 0;
    if (got === 0) {
      state.detail.emptyStreak = (state.detail.emptyStreak || 0) + 1;
      const maxRetry = state.emptyRetryMax ?? 3;
      if (state.detail.emptyStreak <= maxRetry) {
        const wait = Math.min(240, 40 * state.detail.emptyStreak);
        log(`⚠ 连续 ${state.detail.emptyStreak} 次空结果，疑似被限流：暂停 ${wait} 秒后重试 ${name} ${task.year}`);
        saveState();
        render();
        await sleep(wait * 1000);
        gotoDetailTask();          // index 不变 → 重新加载同一页
        return;
      }
      // 重试多次仍然空：记入失败清单，跳过但可一键重来
      state.detail.failed = state.detail.failed || [];
      if (!state.detail.failed.some((x) => x.id === task.id && x.year === task.year)) {
        state.detail.failed.push({ id: task.id, year: task.year, name });
      }
      log(`✗ ${name} ${task.year}：重试 ${maxRetry} 次仍为空，记为失败（可在面板里一键重试）`);
      state.detail.emptyStreak = 0;
    } else {
      state.detail.emptyStreak = 0;
    }

    state.detail.index += 1;
    saveState();
    render();
    await sleep(DETAIL_GAP);
    gotoDetailTask();
  }

  /**
   * 合并所有分片的结果（并发抓取时每个标签页各写各的 state 键）。
   * 单页模式下就是自己的那份。
   */
  function allDetailRows() {
    const merged = { ...detailStore() };
    for (let i = 0; i < 4; i += 1) {
      try {
        const raw = localStorage.getItem(stateKeyFor(i));
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        Object.assign(merged, parsed?.detail?.rows || {});
      } catch { /* 单个分片坏了不影响其它 */ }
    }
    return merged;
  }

  /** 一张总表：年份, 省份, 院校, 所在地, 板块, 专业, 最高分, 最低分, 最高位次, 最低位次, 录取人数 */
  function buildDetailCsv() {
    const head = ['年份', '招生省份', '院校名称', '院校所在地', '板块', '专业名称', '最高分', '最低分', '最高位次', '最低位次', '录取人数'];
    const lines = [head.join(',')];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const entries = Object.values(allDetailRows()).sort((a, b) => (
      a.name.localeCompare(b.name, 'zh-CN') || Number(b.year) - Number(a.year)
    ));

    for (const item of entries) {
      for (const m of item.majors) {
        lines.push([
          item.year, esc(item.province), esc(item.name), esc(item.location), item.plate,
          esc(m.major), m.maxScore ?? '', m.minScore ?? '', m.maxRank ?? '', m.minRank ?? '', m.volume ?? '',
        ].join(','));
      }
      // 院校级兜底行：专业列写「院校最低线」
      for (const s of item.school) {
        lines.push([
          item.year, esc(item.province), esc(item.name), esc(item.location), item.plate,
          esc(`院校最低线（${s.batch || ''}${s.type ? ' ' + s.type : ''}）`), s.maxScore ?? '', s.minScore ?? '', '', s.minRank ?? '', '',
        ].join(','));
      }
    }
    return lines.join('\r\n');
  }

  /* ============================ A4. 一分一段 ============================ */
  /*
   * 一分一段表不是分页接口，而是一份静态 JSON：
   *   static-data.gaokao.cn/www/2.0/section2021/{年份}/{省份ID}/{科类ID}/{批次ID}/lists.json
   * 一条请求就是整张表（天津 2026 有 381 行），末行"累计人数"正好是该年考生总数。
   * 所以：页面打开一次（/colleges/bypart），插件从 performance 里取到 URL 模板，
   * 换年份逐年拉即可——既拿到分数→位次换算表，又拿到百分位要用的分母。
   */

  // 站点上能找到 2016 起的分段表，每年一条静态 JSON，全拉也不贵
  const SEG_YEARS = ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017', '2016'];
  const segResult = () => state.segFetch || (state.segFetch = { rows: [] });

  /** 从页面已发出的请求里找出模板，例如 .../section2021/2026/12/3/1/lists.json */
  function findSegmentTemplate() {
    const urls = performance.getEntriesByType('resource').map((r) => r.name)
      .filter((u) => /section2021\/\d{4}\/\d+\/\d+\/\d+\/lists\.json/.test(u));
    // 取**最后一条**：在页面上换省份/年份后，最新那次请求才代表当前选择
    return urls.length ? urls[urls.length - 1] : null;
  }

  /** 当前一分一段页面上选的省份（优先从标题取，保证和表格内容一致） */
  function currentSegmentProvince() {
    const fromTitle = (document.title || '').match(/^(.+?)一分一段/);
    if (fromTitle) return fromTitle[1].trim();
    return (localStorage.getItem('localprovincename') || state.province || '').replace(/市$/, '');
  }

  async function collectSegments(opts = {}) {
    const tpl = findSegmentTemplate();
    if (!tpl) {
      log('没找到一分一段数据源：请先打开 https://www.gaokao.cn/colleges/bypart');
      return { ok: false, reason: 'no-template' };
    }
    const m = tpl.match(/section2021\/(\d{4})\/(\d+)\/(\d+)\/(\d+)\/lists\.json/);
    if (!m) return { ok: false, reason: 'bad-template' };
    const [, , pid, typeId, batchId] = m;
    const province = currentSegmentProvince();

    const rows = [];
    let done = 0;
    for (const year of SEG_YEARS) {
      const url = `https://static-data.gaokao.cn/www/2.0/section2021/${year}/${pid}/${typeId}/${batchId}/lists.json`;
      try {
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) { log(`一分一段 ${year}：HTTP ${resp.status}`); continue; }
        const json = await resp.json();
        const list = json?.data?.list ?? [];
        for (const row of list) {
          const scoreText = String(row.score ?? '');
          const score = Number((scoreText.match(/\d{2,3}/) || [])[0]);
          const cumulative = Number(row.total);
          if (Number.isFinite(score) && Number.isFinite(cumulative)) {
            rows.push({ year, province, score, cumulative });
          }
        }
        done += 1;
        log(`一分一段 ${year}：${list.length} 行（累计到 ${list.at(-1)?.total ?? '-'}）`);
      } catch (e) {
        log(`一分一段 ${year} 失败：${e.message}`);
      }
      await sleep(500);
    }

    state.segFetch = { rows, province, at: Date.now() };
    saveState();
    render();
    return { ok: rows.length > 0, rows: rows.length, years: done };
  }

  function buildSegmentCsvFromFetch() {
    const lines = ['年份,省份,分数,累计人数'];
    const rows = segResult().rows || [];
    for (const r of [...rows].sort((a, b) => a.year - b.year || b.score - a.score)) {
      lines.push([r.year, r.province, r.score, r.cumulative].join(','));
    }
    return lines.join('\r\n');
  }

  /* ============================ B. 通用表格 ============================ */

  function tableToMatrix(table) {
    const rows = [...table.querySelectorAll('tr')].map((tr) =>
      [...tr.querySelectorAll('th,td')].map((td) => (td.innerText || '').replace(/\s+/g, ' ').trim()));
    return rows.filter((r) => r.length > 0);
  }

  /** 表格"像数据表"的程度：行数 × 数字密度 */
  function scoreTable(matrix) {
    if (matrix.length < 2) return 0;
    const cols = Math.max(...matrix.map((r) => r.length));
    if (cols < 2) return 0;
    let numeric = 0;
    let total = 0;
    for (const row of matrix.slice(1)) {
      for (const cell of row) {
        total += 1;
        if (/^-?\d+(\.\d+)?$|^\d{3}\s*\/\s*\d+$/.test(cell)) numeric += 1;
      }
    }
    return matrix.length * (total ? numeric / total : 0);
  }

  function scanTables() {
    return [...document.querySelectorAll('table')]
      .map((el, index) => {
        const matrix = tableToMatrix(el);
        return { index, el, matrix, score: scoreTable(matrix) };
      })
      .filter((t) => t.matrix.length >= 2 && Math.max(...t.matrix.map((r) => r.length)) >= 2)
      .sort((a, b) => b.score - a.score);
  }

  function guessMapping(headerRow) {
    const map = {};
    for (const [field] of FIELDS) map[field] = -1;
    headerRow.forEach((text, index) => {
      if (!text) return;
      for (const [field, pattern] of HEADER_RULES) {
        if (map[field] === -1 && pattern.test(text)) { map[field] = index; return; }
      }
    });
    return map;
  }

  const MAPPING_CACHE = (() => {
    try { return JSON.parse(localStorage.getItem(MAP_KEY)) || {}; } catch { return {}; }
  })();

  function saveMapping(host, mapping) {
    MAPPING_CACHE[host] = mapping;
    try { localStorage.setItem(MAP_KEY, JSON.stringify(MAPPING_CACHE)); } catch { /* ignore */ }
  }

  /** 把单元格里的 "670/1301" 拆成分数与位次 */
  function splitScoreRank(cell) {
    const m = String(cell || '').match(/^(\d{3}(?:\.\d+)?)\s*\/\s*(\d+)$/);
    return m ? { score: m[1], rank: m[2] } : null;
  }

  function extractRows(table, mapping, ctx) {
    const header = table.matrix[0] ?? [];
    const isSegment = mapping.cumulative !== -1 && mapping.score !== -1;
    const out = [];
    let bad = 0;

    for (const row of table.matrix.slice(1)) {
      const cell = (field) => (mapping[field] >= 0 ? String(row[mapping[field]] ?? '').trim() : '');

      if (isSegment) {
        const scoreText = cell('score');
        const cumulative = Number(cell('cumulative').replace(/[^\d]/g, ''));
        const score = Number((scoreText.match(/\d{2,3}/) || [])[0]);
        if (!Number.isFinite(score) || !Number.isFinite(cumulative) || !cumulative) { bad += 1; continue; }
        out.push({
          year: Number(cell('year')) || ctx.year,
          province: cell('province') || ctx.province,
          score,
          cumulative,
        });
        continue;
      }

      const major = cell('major') || ctx.defaultMajor;
      if (!major) { bad += 1; continue; }

      let lowScore = cell('lowScore');
      let lowRank = cell('lowRank');
      const combo = splitScoreRank(lowScore);
      if (combo && !lowRank) { lowScore = combo.score; lowRank = combo.rank; }

      if (!lowScore && !lowRank) { bad += 1; continue; }

      out.push({
        year: Number(cell('year')) || ctx.year,
        province: cell('province') || ctx.province,
        school: cell('school') || ctx.school,
        location: cell('location') || ctx.location,
        major,
        highScore: cell('highScore'),
        lowScore,
        highRank: cell('highRank'),
        lowRank,
        volume: cell('volume'),
      });
    }

    return { rows: out, bad, header };
  }

  /* ============================ 导出 ============================ */

  const csvCell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  function download(filename, text) {
    const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function buildScoreCsv() {
    const header = ['年份', '招生省份', '院校名称', '院校所在地', '板块', '专业名称',
      '最高分', '最低分', '最高位次', '最低位次', '录取人数'];
    const lines = [header.join(',')];

    for (const row of Object.values(state.rows)) {
      for (const [year, d] of Object.entries(row.years)) {
        if (!d.rank) continue;
        lines.push([year, state.province, csvCell(row.name), csvCell(row.location), row.plate,
          '院校最低线', '', d.min, '', d.rank, ''].join(','));
      }
    }
    for (const r of state.scores) {
      lines.push([r.year, csvCell(r.province), csvCell(r.school), csvCell(r.location), '',
        csvCell(r.major), r.highScore, r.lowScore, r.highRank, r.lowRank, r.volume].join(','));
    }
    return lines.join('\r\n');
  }

  function buildSegmentCsv() {
    const lines = ['年份,省份,分数,累计人数'];
    for (const r of state.segments) lines.push([r.year, csvCell(r.province), r.score, r.cumulative].join(','));
    return lines.join('\r\n');
  }

  /* ============================ 面板 ============================ */

  let panel = null;
  let currentTable = null;
  let currentMapping = null;
  let expanded = IS_GK;

  function render() {
    if (!panel) return;
    const planTotal = Object.keys(planResults()).length;
    panel.querySelector('.gk-status').textContent =
      `${state.running ? '运行中' : '空闲'} · 院校 ${Object.keys(state.rows).length} 所 · 分数行 ${state.scores.length} · 一分一段 ${state.segments.length} · 计划 ${planTotal} 所`;
    panel.querySelector('.gk-log').innerHTML = state.log.slice(0, 4)
      .map((l) => `<div>${l.replace(/</g, '&lt;')}</div>`).join('');

    const batchBtn = panel.querySelector('.gk-batch');
    if (batchBtn) {
      batchBtn.textContent = state.running ? '暂停' : (state.index > 0 && state.index < state.queue.length ? '继续' : '批量抓院校线');
    }

    const planStatus = panel.querySelector('.gk-plan-status');
    if (planStatus) {
      const q = state.plan.queue.length;
      const i = state.plan.index;
      if (state.plan.running) {
        const task = state.plan.queue[i];
        const meta = task ? schoolById.get(String(task.id)) : null;
        planStatus.textContent = `采集中 ${i + 1}/${q}：${meta ? meta[2] : task?.id ?? ''} ${task?.year ?? ''}`;
      } else if (q > 0) {
        planStatus.textContent = `已停止 / 已完成（${Math.min(i, q)}/${q}）`;
      } else {
        planStatus.textContent = '';
      }
    }

    const segStatus = panel.querySelector('.gk-seg-status');
    if (segStatus) {
      const rows = segResult().rows?.length ?? 0;
      const years = new Set((segResult().rows || []).map((r) => r.year));
      segStatus.textContent = rows
        ? `已采 ${rows} 行 / ${years.size} 年（${segResult().province || ''}）· 末行累计人数即考生总数`
        : '';
    }

    // 名次区间提示：一眼看到"这次会跑多少所、几年"
    const rangeHint = panel.querySelector('.gk-range-hint');
    if (rangeHint) {
      const picked = selectedSchools().length;
      rangeHint.textContent = `第 ${state.rankFrom}–${state.rankTo} 名 · 共 ${picked} 所 · 最近 ${state.yearCount} 年（榜单共 ${SCHOOLS.length} 所）`;
    }

    const detailStatus = panel.querySelector('.gk-detail-status');
    if (detailStatus) {
      const merged = allDetailRows();
      const got = Object.keys(merged).length;
      const majors = Object.values(merged).reduce((n, x) => n + (x.majors?.length ?? 0), 0);
      const q = state.detail.queue.length;
      const i = state.detail.index;
      if (!window.__gkNet) {
        // 钩子没装上 = 采集一定拿不到数据，先把这个说出来，别让用户以为是"没公布"
        detailStatus.textContent = '⚠ 网络钩子未生效：脚本没能在页面脚本之前运行。请刷新页面；若用扩展，确认 manifest 的 run_at 是 document_start。';
        detailStatus.style.color = '#f39c12';
      } else if (state.detail.running) {
        const task = state.detail.queue[i];
        const meta = task ? schoolById.get(String(task.id)) : null;
        const failedCount = (state.detail.failed || []).length;
        const streak = state.detail.emptyStreak || 0;
        detailStatus.style.color = streak > 0 ? '#f39c12' : '#9aa6bd';
        detailStatus.textContent = `采集中 ${i + 1}/${q}：${meta ? meta[2] : task?.id ?? ''} ${task?.year ?? ''}`
          + ` · 已收 ${got} 组 / ${majors} 个专业`
          + `${failedCount ? ` · 失败 ${failedCount}` : ''}`
          + `${streak > 0 ? ` · 疑似限流重试中(${streak})` : ''}`;
      } else {
        const failedCount = (state.detail.failed || []).length;
        detailStatus.style.color = failedCount ? '#f39c12' : '#9aa6bd';
        detailStatus.textContent = got
          ? `已收 ${got} 组「院校×年份」/ ${majors} 个专业${failedCount ? ` · 失败 ${failedCount}（点下面重试）` : ''}`
          : '钩子正常，尚未采集';
      }
    }

    const retryBtn = panel.querySelector('.gk-retry-failed');
    if (retryBtn) {
      const n = (state.detail.failed || []).length;
      retryBtn.textContent = `重试失败(${n})`;
      retryBtn.style.opacity = n ? '1' : '0.5';
    }
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'gk-panel-root';
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647', 'width:300px',
      'background:#16213e', 'color:#e9edf5', 'border:1px solid #0f3460', 'border-radius:10px',
      'padding:12px', 'font-size:12px', 'line-height:1.6', 'box-shadow:0 8px 24px rgba(0,0,0,.45)',
      'font-family:"Microsoft YaHei",sans-serif', 'max-height:80vh', 'overflow:auto',
    ].join(';');

    const provinceOptions = PROVINCES.map(([n]) => `<option value="${n}"${n === state.province ? ' selected' : ''}>${n}</option>`).join('');
    const fieldOptions = (header, selected) => ['<option value="-1">（无）</option>']
      .concat(header.map((h, i) => `<option value="${i}"${i === selected ? ' selected' : ''}>${i + 1}. ${(h || '(空)').slice(0, 12)}</option>`))
      .join('');

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <b style="color:#ec0000;">高考顺 · 采集器</b>
        <span class="gk-toggle" style="cursor:pointer;color:#6b7793;">收起</span>
      </div>
      <div class="gk-body">
        <div class="gk-status" style="color:#9aa6bd;margin-bottom:8px;"></div>

        <label style="display:block;margin-bottom:6px;">招生省份
          <select class="gk-province" style="width:100%;margin-top:4px;background:#0b1a33;color:#fff;border:1px solid #0f3460;border-radius:4px;padding:4px;">
            ${provinceOptions}
          </select>
        </label>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <label style="flex:1;">名次从
            <input class="gk-rank-from" type="number" min="1" max="${SCHOOLS.length}" value="${state.rankFrom}" style="width:100%;margin-top:4px;background:#0b1a33;color:#fff;border:1px solid #0f3460;border-radius:4px;padding:4px;">
          </label>
          <label style="flex:1;">到
            <input class="gk-rank-to" type="number" min="1" max="${SCHOOLS.length}" value="${state.rankTo}" style="width:100%;margin-top:4px;background:#0b1a33;color:#fff;border:1px solid #0f3460;border-radius:4px;padding:4px;">
          </label>
        </div>
        <label style="display:block;margin-bottom:6px;">抓最近几年
          <select class="gk-year-count" style="width:100%;margin-top:4px;background:#0b1a33;color:#fff;border:1px solid #0f3460;border-radius:4px;padding:4px;">
            ${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}"${n === state.yearCount ? ' selected' : ''}>最近 ${n} 年（${YEARS.slice(0, n).join('、')}）</option>`).join('')}
          </select>
        </label>
        <div class="gk-range-hint" style="color:#6b7793;font-size:10px;margin-bottom:6px;"></div>

        <button class="gk-onestep" style="width:100%;padding:9px;background:#ec0000;color:#fff;border:none;border-radius:5px;font-weight:700;font-size:13px;cursor:pointer;margin-bottom:6px;">一键抓取</button>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <button class="gk-detail-stop" style="flex:1;padding:6px;background:#4a5568;color:#fff;border:none;border-radius:5px;cursor:pointer;">停止</button>
          <button class="gk-detail-export" style="flex:1;padding:6px;background:#1f9d55;color:#fff;border:none;border-radius:5px;cursor:pointer;">导出总表</button>
          <button class="gk-detail-push" style="flex:1;padding:6px;background:#2f6fd0;color:#fff;border:none;border-radius:5px;cursor:pointer;">导出并导入</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:11px;color:#9aa6bd;">
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input type="checkbox" class="gk-skip-done" style="margin:0;" /> 跳过已抓过的
          </label>
          <button class="gk-retry-failed" style="margin-left:auto;padding:3px 8px;background:#7a4a1f;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">重试失败(0)</button>
        </div>
        <div class="gk-detail-status" style="margin-top:6px;color:#9aa6bd;font-size:11px;margin-bottom:6px;"></div>

        <details class="gk-sec-seg" open>
          <summary style="cursor:pointer;color:#f39c12;margin-top:8px;">一分一段表（顺带算出考生总数）</summary>
          <div style="padding-top:8px;">
            <div style="color:#6b7793;font-size:11px;margin-bottom:6px;">
              在 <b>/colleges/bypart</b> 页面上选好省份（点地区名，如「北京」），再回来点采集——采的就是你选的那个省
            </div>
            <button class="gk-seg-fetch" style="width:100%;padding:6px;background:#0f3460;color:#fff;border:none;border-radius:5px;cursor:pointer;margin-bottom:6px;">采集全部年份</button>
            <button class="gk-seg-export" style="width:100%;padding:6px;background:#1f9d55;color:#fff;border:none;border-radius:5px;cursor:pointer;">导出一分一段 CSV</button>
            <div class="gk-seg-status" style="margin-top:6px;color:#9aa6bd;font-size:11px;"></div>
          </div>
        </details>

        <details class="gk-sec-more">
          <summary style="cursor:pointer;color:#6b7793;font-size:11px;">分项功能（一般不用）</summary>

        <details class="gk-sec-a">
          <summary style="cursor:pointer;color:#f39c12;">掌上高考批量（旧：只抓院校线）</summary>
          <div style="padding-top:8px;">
            <button class="gk-batch" style="width:100%;padding:7px;background:#0f3460;color:#fff;border:none;border-radius:5px;cursor:pointer;margin-bottom:6px;">批量抓院校线</button>
            <div style="display:flex;gap:6px;">
              <button class="gk-one" style="flex:1;padding:6px;background:#0f3460;color:#fff;border:none;border-radius:5px;cursor:pointer;">抓当前页</button>
              <button class="gk-export-gk" style="flex:1;padding:6px;background:#1f9d55;color:#fff;border:none;border-radius:5px;cursor:pointer;">导出院校线</button>
            </div>
          </div>
        </details>

        <details class="gk-sec-detail" ${IS_GK ? 'open' : ''}>
          <summary style="cursor:pointer;color:#f39c12;margin-top:8px;">专业明细（推荐，一张总表）</summary>
          <div style="padding-top:8px;">
            <div style="color:#6b7793;font-size:11px;margin-bottom:6px;">
              院校线 + 每个专业的最低分 / 最低位次 / 录取人数
            </div>
            <div style="display:flex;gap:6px;margin-bottom:6px;">
              <button class="gk-detail-one" style="flex:1;padding:6px;background:#0f3460;color:#fff;border:none;border-radius:5px;cursor:pointer;">采本校</button>
              <button class="gk-detail-all" style="flex:1;padding:6px;background:#ec0000;color:#fff;border:none;border-radius:5px;cursor:pointer;">批量采集</button>
            </div>
            <div style="display:flex;gap:6px;">
              <button class="gk-detail-stop" style="flex:1;padding:6px;background:#4a5568;color:#fff;border:none;border-radius:5px;cursor:pointer;">停止</button>
              <button class="gk-detail-export" style="flex:1;padding:6px;background:#1f9d55;color:#fff;border:none;border-radius:5px;cursor:pointer;">导出总表</button>
            </div>
            <div class="gk-detail-status" style="margin-top:6px;color:#9aa6bd;font-size:11px;"></div>
          </div>
        </details>

        <details class="gk-sec-plan" ${IS_GK ? 'open' : ''}>
          <summary style="cursor:pointer;color:#f39c12;margin-top:8px;">招生计划（招生人数）</summary>
          <div style="padding-top:8px;">
            <div style="color:#6b7793;font-size:11px;margin-bottom:6px;">
              按年份逐个打开 → 自动翻页 → 把「计划招生」列求和
            </div>
            <div style="display:flex;gap:6px;margin-bottom:6px;">
              <button class="gk-plan-one" style="flex:1;padding:6px;background:#0f3460;color:#fff;border:none;border-radius:5px;cursor:pointer;">采本校</button>
              <button class="gk-plan-all" style="flex:1;padding:6px;background:#ec0000;color:#fff;border:none;border-radius:5px;cursor:pointer;">批量采集</button>
            </div>
            <div style="display:flex;gap:6px;">
              <button class="gk-plan-stop" style="flex:1;padding:6px;background:#4a5568;color:#fff;border:none;border-radius:5px;cursor:pointer;">停止</button>
              <button class="gk-plan-export" style="flex:1;padding:6px;background:#1f9d55;color:#fff;border:none;border-radius:5px;cursor:pointer;">导出计划</button>
            </div>
            <div class="gk-plan-status" style="margin-top:6px;color:#9aa6bd;font-size:11px;"></div>
          </div>
        </details>

        <details class="gk-sec-b" open>
          <summary style="cursor:pointer;color:#f39c12;margin-top:8px;">本页表格抓取</summary>
          <div style="padding-top:8px;">
            <button class="gk-scan" style="width:100%;padding:6px;background:#0f3460;color:#fff;border:none;border-radius:5px;cursor:pointer;">扫描本页表格</button>
            <select class="gk-table-pick" style="width:100%;margin-top:6px;background:#0b1a33;color:#fff;border:1px solid #0f3460;border-radius:4px;padding:4px;display:none;"></select>
            <div class="gk-map" style="display:none;margin-top:8px;max-height:210px;overflow:auto;"></div>
            <div class="gk-ctx" style="display:none;margin-top:8px;grid-template-columns:1fr 1fr;gap:6px;">
              <label>年份<input class="gk-ctx-year" type="number" placeholder="2025" style="width:100%;background:#0b1a33;color:#fff;border:1px solid #0f3460;border-radius:4px;padding:4px;"></label>
              <label>省份<input class="gk-ctx-province" type="text" placeholder="天津" style="width:100%;background:#0b1a33;color:#fff;border:1px solid #0f3460;border-radius:4px;padding:4px;"></label>
              <label style="grid-column:1/-1;">院校名（表里没有时用）<input class="gk-ctx-school" type="text" style="width:100%;background:#0b1a33;color:#fff;border:1px solid #0f3460;border-radius:4px;padding:4px;"></label>
              <label style="grid-column:1/-1;">默认专业名（表里没有时用）<input class="gk-ctx-major" type="text" value="院校最低线" style="width:100%;background:#0b1a33;color:#fff;border:1px solid #0f3460;border-radius:4px;padding:4px;"></label>
            </div>
            <div class="gk-preview" style="margin-top:8px;color:#9aa6bd;font-size:11px;"></div>
            <div style="display:flex;gap:6px;margin-top:6px;">
              <button class="gk-add" style="flex:1;padding:6px;background:#27ae60;color:#fff;border:none;border-radius:5px;cursor:pointer;display:none;">加入数据</button>
              <button class="gk-export-seg" style="flex:1;padding:6px;background:#8e44ad;color:#fff;border:none;border-radius:5px;cursor:pointer;">导出一分一段</button>
            </div>
          </div>
        </details>
        </details>

        <div class="gk-log" style="margin-top:8px;color:#6b7793;font-size:11px;max-height:80px;overflow:auto;"></div>
        <div style="margin-top:6px;color:#6b7793;font-size:10px;">数据存在浏览器本地；导出后拖进高考顺即可</div>
      </div>
    `;

    document.body.appendChild(panel);

    panel.querySelector('.gk-toggle').addEventListener('click', () => {
      expanded = !expanded;
      panel.querySelector('.gk-body').style.display = expanded ? 'block' : 'none';
      panel.querySelector('.gk-toggle').textContent = expanded ? '收起' : '展开';
    });

    const $ = (sel) => panel.querySelector(sel);

    $('.gk-province').addEventListener('change', (e) => {
      state.province = e.target.value;
      saveState();
      applyProvince();
      log(`省份切到 ${state.province}，刷新页面生效`);
    });

    // 名次区间 / 年份数：改完立即生效，下一次点按钮就按新范围跑
    const readRange = () => {
      const max = SCHOOLS.length;
      const clamp = (v, d) => Math.min(max, Math.max(1, Number(v) || d));
      const a = clamp($('.gk-rank-from').value, 1);
      const b = clamp($('.gk-rank-to').value, 100);
      state.rankFrom = Math.min(a, b);
      state.rankTo = Math.max(a, b);
      state.yearCount = Math.min(6, Math.max(1, Number($('.gk-year-count').value) || 6));
      $('.gk-rank-from').value = state.rankFrom;
      $('.gk-rank-to').value = state.rankTo;
      saveState();
      render();
    };
    ['.gk-rank-from', '.gk-rank-to', '.gk-year-count'].forEach((sel) => {
      $(sel).addEventListener('change', readRange);
    });

    $('.gk-batch').addEventListener('click', () => {
      if (state.running) { state.running = false; saveState(); render(); log('已暂停'); return; }
      if (state.index > 0 && state.index < state.queue.length) {
        state.running = true; saveState(); applyProvince();
        const next = state.queue[state.index];
        if (next) location.href = `https://www.gaokao.cn/school/${next}/special`;
        return;
      }
      const list = selectedSchools();
      if (!list.length) { alert('这个名次区间里没有学校'); return; }
      if (!confirm(`从第 ${state.rankFrom} 名开始抓 ${list.length} 所 × ${state.yearCount} 年？（每所约 3–5 秒）`)) return;
      state.queue = list.map((s) => String(s[1]));
      state.index = 0;
      state.rows = {};
      state.running = true;
      saveState();
      applyProvince();
      location.href = `https://www.gaokao.cn/school/${state.queue[0]}/special`;
    });

    $('.gk-one').addEventListener('click', async () => {
      const btn = $('.gk-one');
      btn.disabled = true; btn.textContent = '抓取中…';
      const r = await collectCurrentSchool();
      btn.disabled = false; btn.textContent = '抓当前页';
      log(r.ok ? `✓ ${r.name}：${r.years} 年` : `✗ ${r.reason}`);
    });

    $('.gk-export-gk').addEventListener('click', () => {
      const csv = buildScoreCsv();
      if (csv.split('\r\n').length <= 1) { alert('还没有数据'); return; }
      download(`高考顺_院校线_${state.province}.csv`, csv);
    });

    $('.gk-plan-one').addEventListener('click', () => {
      const id = currentSchoolId();
      if (!id) { alert('请先打开某所学校的页面'); return; }
      if (!confirm('采集本校 2021–2026 的招生计划？（约 1 分钟，会连续跳转 6 次）')) return;
      startPlanQueue([id], PLAN_YEARS);
    });

    $('.gk-plan-all').addEventListener('click', () => {
      if (state.plan.running) { log('已经在跑了，先停止再重开'); return; }
      const list = selectedSchools();
      if (!list.length) { alert('这个名次区间里没有学校'); return; }
      const msg = `采集第 ${state.rankFrom}–${state.rankTo} 名共 ${list.length} 所 × ${state.yearCount} 年的招生计划？\n每所学校要跳转 ${state.yearCount} 次，中途可以点「停止」。`;
      if (!confirm(msg)) return;
      startPlanQueue(list.map((s) => String(s[1])), selectedYears());
    });

    $('.gk-plan-stop').addEventListener('click', () => {
      stopPlanQueue();
      log('已停止招生计划采集');
    });

    /* ---------- 一键抓取 ---------- */
    $('.gk-onestep').addEventListener('click', () => {
      if (state.detail.running || state.plan.running || state.running) {
        alert('还有采集任务在跑，先点「停止」'); return;
      }
      const list = selectedSchools();
      if (!list.length) { alert('这个名次区间里没有学校'); return; }
      const total = list.length * state.yearCount;
      const minutes = Math.max(1, Math.ceil((total * 6) / 60));
      const msg = `一键抓取\n\n`
        + `范围：第 ${state.rankFrom}–${state.rankTo} 名，共 ${list.length} 所 × ${state.yearCount} 年 = ${total} 个页面\n`
        + `内容：院校线 + 每个专业的最低分 / 最低位次 / 录取人数\n`
        + `预计：约 ${minutes} 分钟，可随时停止，进度会保留\n\n开始？`;
      if (!confirm(msg)) return;
      startDetailQueue(list.map((s) => String(s[1])), selectedYears());
    });

    /* ---------- 一分一段 ---------- */
    $('.gk-seg-fetch').addEventListener('click', async () => {
      const btn = $('.gk-seg-fetch');
      btn.disabled = true;
      btn.textContent = '采集中…';
      const r = await collectSegments();
      btn.disabled = false;
      btn.textContent = '采集全部年份';
      if (r.ok) log(`一分一段完成：${r.rows} 行 / ${r.years} 年`);
      else alert('没找到一分一段数据源：请先打开 /colleges/bypart（一分一段页）再点采集');
    });

    $('.gk-seg-export').addEventListener('click', () => {
      const csv = buildSegmentCsvFromFetch();
      if (csv.split('\r\n').length <= 1) { alert('还没有一分一段数据'); return; }
      const province = segResult().province || state.province;
      download(`高考顺_一分一段_${province}.csv`, csv);
    });

    /* ---------- 专业明细 ---------- */
    $('.gk-detail-one').addEventListener('click', () => {
      const id = currentSchoolId();
      if (!id) { alert('请先打开某所学校的页面'); return; }
      if (!confirm(`采集本校最近 ${state.yearCount} 年的专业明细？（会连续跳转 ${state.yearCount} 次）`)) return;
      startDetailQueue([id], selectedYears());
    });

    $('.gk-detail-all').addEventListener('click', () => {
      if (state.detail.running) { log('明细已经在跑了，先停止再重开'); return; }
      const list = selectedSchools();
      if (!list.length) { alert('这个名次区间里没有学校'); return; }
      const msg = `采集第 ${state.rankFrom}–${state.rankTo} 名共 ${list.length} 所 × ${state.yearCount} 年的专业明细？\n`
        + `共 ${list.length * state.yearCount} 个页面，每个页面 2–5 页数据。可以随时停止，进度会保留。`;
      if (!confirm(msg)) return;
      startDetailQueue(list.map((s) => String(s[1])), selectedYears());
    });

    $('.gk-detail-stop').addEventListener('click', () => {
      stopDetailQueue();
      log('已停止专业明细采集');
    });

    $('.gk-detail-export').addEventListener('click', () => {
      const csv = buildDetailCsv();
      if (csv.split('\r\n').length <= 1) { alert('还没有专业明细数据'); return; }
      download(`高考顺_专业明细_${state.province}.csv`, csv);
    });
    /*
     * 导出并自动导入：
     *   浏览器不允许 HTTPS 页面（www.gaokao.cn）直接写本地文件，也不允许它
     *   fetch http://127.0.0.1（混合内容 / 私有网络访问限制，实测被静默拦截）。
     *   所以这里只负责"下载"，由本地看护进程（导入数据.cmd）发现下载目录里的
     *   新文件并自动合并进 data/。既不改浏览器设置，也不用申请额外权限。
     */
    $('.gk-detail-push').addEventListener('click', () => {
      const csv = buildDetailCsv();
      if (csv.split('\r\n').length <= 1) { alert('还没有专业明细数据'); return; }
      const fileName = `高考顺_专业明细_${state.province}.csv`;
      download(fileName, csv);
      log(`已导出 ${fileName}。如果开着「导入数据.cmd」，几秒后会自动写入 data/；没开就手动拖进去。`);
    });
    // 续跑开关：默认跳过已抓过的「校×年」
    const skipBox = $('.gk-skip-done');
    if (skipBox) {
      skipBox.checked = state.skipDone !== false;
      skipBox.addEventListener('change', () => {
        state.skipDone = skipBox.checked;
        saveState();
        log(skipBox.checked ? '已开启：换区间续跑时跳过抓过的' : '已关闭：会重新抓取范围内所有学校');
      });
    }

    // 一键重试失败任务（多半是被限流时空跑掉的那些）
    $('.gk-retry-failed').addEventListener('click', () => {
      const failed = state.detail.failed || [];
      if (!failed.length) { alert('没有失败的任务'); return; }
      state.detail.queue = failed.map((f) => ({ id: String(f.id), year: String(f.year), phase: 'detail' }));
      state.detail.index = 0;
      state.detail.failed = [];
      state.detail.emptyStreak = 0;
      state.detail.running = true;
      saveState();
      render();
      log(`重试 ${state.detail.queue.length} 个失败任务`);
      gotoDetailTask();
    });

    $('.gk-plan-export').addEventListener('click', () => {
      const csv = buildPlanCsv();
      if (csv.split('\r\n').length <= 1) { alert('还没有招生计划数据'); return; }
      download(`高考顺_招生计划_${state.province}.csv`, csv);
    });

    $('.gk-export-seg').addEventListener('click', () => {
      if (!state.segments.length) { alert('还没有一分一段数据'); return; }
      download('高考顺_一分一段.csv', buildSegmentCsv());
    });

    $('.gk-scan').addEventListener('click', () => {
      const tables = scanTables();
      if (!tables.length) { log('本页没有可用的表格'); return; }
      const pick = $('.gk-table-pick');
      pick.style.display = 'block';
      pick.innerHTML = tables.map((t, i) =>
        `<option value="${i}">表${i + 1}：${t.matrix.length} 行 × ${Math.max(...t.matrix.map((r) => r.length))} 列｜${(t.matrix[0] || []).slice(0, 3).join(' / ').slice(0, 30)}</option>`).join('');
      pick.onchange = () => chooseTable(tables[Number(pick.value)]);
      chooseTable(tables[0]);
      log(`找到 ${tables.length} 个表格`);
    });

    function chooseTable(t) {
      currentTable = t;
      const header = t.matrix[0] ?? [];
      const cached = MAPPING_CACHE[location.hostname];
      currentMapping = (cached && Object.keys(cached).length) ? { ...guessMapping(header), ...cached } : guessMapping(header);

      const mapBox = $('.gk-map');
      mapBox.style.display = 'block';
      mapBox.innerHTML = FIELDS.map(([field, label]) =>
        `<label style="display:flex;justify-content:space-between;gap:6px;margin-bottom:3px;">
          <span style="color:#9aa6bd;">${label}</span>
          <select data-field="${field}" style="flex:1;max-width:150px;background:#0b1a33;color:#fff;border:1px solid #0f3460;border-radius:4px;">${fieldOptions(header, currentMapping[field])}</select>
        </label>`).join('');

      mapBox.querySelectorAll('select').forEach((sel) => {
        sel.addEventListener('change', () => updatePreview());
      });

      $('.gk-ctx').style.display = 'grid';
      $('.gk-add').style.display = 'block';
      updatePreview();
    }

    function readMapping() {
      const map = {};
      panel.querySelectorAll('.gk-map select').forEach((sel) => {
        map[sel.dataset.field] = Number(sel.value);
      });
      return map;
    }

    function readCtx() {
      return {
        year: Number($('.gk-ctx-year').value) || new Date().getFullYear(),
        province: $('.gk-ctx-province').value.trim() || state.province,
        school: $('.gk-ctx-school').value.trim(),
        location: '',
        defaultMajor: $('.gk-ctx-major').value.trim(),
      };
    }

    function updatePreview() {
      if (!currentTable) return;
      currentMapping = readMapping();
      const { rows, bad } = extractRows(currentTable, currentMapping, readCtx());
      const isSeg = currentMapping.cumulative !== -1 && currentMapping.score !== -1;
      const head = rows.slice(0, 2).map((r) => isSeg
        ? `${r.year} ${r.province} ${r.score}→${r.cumulative}`
        : `${r.year} ${r.school || '(未填院校)'} ${r.major} 分${r.lowScore || '-'} 位${r.lowRank || '-'}`).join('<br>');
      $('.gk-preview').innerHTML = `识别为 <b style="color:#f39c12;">${isSeg ? '一分一段表' : '分数数据'}</b>：${rows.length} 行可入库，${bad} 行跳过<br>${head}`;
    }

    $('.gk-add').addEventListener('click', () => {
      if (!currentTable) return;
      const mapping = readMapping();
      const ctx = readCtx();
      const { rows, bad } = extractRows(currentTable, mapping, ctx);
      const isSeg = mapping.cumulative !== -1 && mapping.score !== -1;

      if (isSeg) {
        state.segments.push(...rows);
        saveMapping(location.hostname, mapping);
        saveState();
        log(`加入一分一段 ${rows.length} 行（跳过 ${bad}）`);
      } else {
        state.scores.push(...rows);
        saveMapping(location.hostname, mapping);
        saveState();
        log(`加入分数 ${rows.length} 行（跳过 ${bad}）`);
      }
      render();
    });

    render();
  }

  /* ============================ 启动 ============================ */

  function boot() {
    if (document.getElementById('gk-panel-root')) return;
    const hasTable = document.querySelector('table');
    if (!IS_GK && !hasTable) return;   // 其它站点没有表格就别打扰

    buildPanel();
    if (!expanded) {
      panel.querySelector('.gk-body').style.display = 'none';
      panel.querySelector('.gk-toggle').textContent = '展开';
    }
    if (IS_GK) {
      applyProvinceIfNeeded();
      runIfBatch().catch((e) => log('异常：' + e.message));
      runPlanTaskIfNeeded().catch((e) => log('计划采集异常：' + e.message));
      runDetailTaskIfNeeded().catch((e) => log('明细采集异常：' + e.message));
    }
  }

  function applyProvinceIfNeeded() {
    const current = localStorage.getItem('localprovinceid');
    const want = PROVINCES.find(([n]) => n === state.province);
    if (want && current !== String(want[1])) applyProvince();
  }

  // 页面可能长时间停在 loading（广告/统计脚本拖住），所以除了 DOMContentLoaded
  // 再挂定时兜底；boot 本身幂等，重复调用无副作用。
  function scheduleBoot() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 1200), { once: true });
      setTimeout(boot, 6000);
      setTimeout(boot, 12000);
    } else {
      setTimeout(boot, 1200);
    }
  }

  scheduleBoot();
})();
