/**
 * Invoice 空白（過渡應急 PDF，與出貨無關）
 * 共用 invoice.js 的編輯／儲存／PDF 邏輯
 */
async function invoice_blankInit(){
  invStandaloneMode_ = false;
  invBindEditorEvents_();
  invBindBlankSearch_();
  await invLoadCompanyProfile_().catch(() => {});
  await invRefreshCiMap_(true);
  await invRenderBlankList_();
  invCloseBlankEditor_();
}

async function invCloseBlankEditor_(){
  invCloseEditor_();
  await invRenderBlankList_().catch(() => {});
  const list = document.getElementById("invBlankListCard");
  if(list){
    try{ list.scrollIntoView({ behavior: "smooth", block: "start" }); }catch(_e){}
  }
}
