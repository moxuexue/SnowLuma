import { RequestUtil, cookieToString, getBknFromCookie } from './request-util';

export interface SetNoticeRetSuccess {
    ec?: number;
    em?: string;
    [key: string]: any;
}

export interface WebApiGroupNoticeFeed {
    fid: string;
    u: number;
    pubt: number;
    msg: {
        text: string;
        pics?: Array<{ id: string; w: number; h: number }>;
    };
    settings: any;
    read_num: number;
    [key: string]: any;
}

export interface WebApiGroupNoticeRet {
    ec: number;
    em?: string;
    feeds?: Record<string, WebApiGroupNoticeFeed>;
    [key: string]: any;
}


/**
 * 发送群公告 Web API
 */
export async function setGroupNoticeWebAPI(
    cookieObject: Record<string, string>,
    groupCode: string,
    content: string,
    pinned: number = 0,
    type: number = 1,
    isShowEditCard: number = 1,
    tipWindowType: number = 1,
    confirmRequired: number = 1,
    picId: string = '',
    imgWidth: number = 540,
    imgHeight: number = 300
): Promise<SetNoticeRetSuccess | undefined> {
    try {
        const settings = JSON.stringify({
            is_show_edit_card: isShowEditCard,
            tip_window_type: tipWindowType,
            confirm_required: confirmRequired,
        });

        const externalParam = {
            pic: picId,
            imgWidth: imgWidth.toString(),
            imgHeight: imgHeight.toString(),
        };

        const url = `https://web.qun.qq.com/cgi-bin/announce/add_qun_notice?${new URLSearchParams({
            bkn: getBknFromCookie(cookieObject),
            qid: groupCode,
            text: content,
            pinned: pinned.toString(),
            type: type.toString(),
            settings,
            ...(picId === '' ? {} : externalParam),
        }).toString()}`;

        const ret = await RequestUtil.HttpGetJson<SetNoticeRetSuccess>(
            url,
            'POST', // 注意这里必须是 POST
            '',
            { Cookie: cookieToString(cookieObject) }
        );
        return ret;
    } catch (e) {
        return undefined;
    }
}

export async function getGroupNoticeWebAPI(
    cookieObject: Record<string, string>,
    groupCode: string
): Promise<WebApiGroupNoticeRet | undefined> {
    const bkn = getBknFromCookie(cookieObject);


    const params = new URLSearchParams({
        bkn: bkn,
        qid: groupCode,
        ft: '23',
        ni: '1',
        i: '1',
        log_read: '1',
        platform: '1',
        s: '-1',
    }).toString();

    const url = `https://web.qun.qq.com/cgi-bin/announce/get_t_list?${params}&n=20`;

    try {
        const ret = await RequestUtil.HttpGetJson<WebApiGroupNoticeRet>(
            url,
            'GET',
            '',
            { Cookie: cookieToString(cookieObject) }
        );
        return ret?.ec === 0 ? ret : undefined;
    } catch {
        return undefined;
    }
}