import { collection, doc, getDoc, getDocs, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { priceOrder } from './pricing.js';

const checkedInt=(n,label,min=0,max=10000000)=>{
 if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(label+'不正確');
 return n;
};
const validRecipe=p=>Array.isArray(p.recipe)&&p.recipe.length>0&&p.recipe.every(r=>typeof r.id==='string'&&Number.isSafeInteger(r.qty)&&r.qty>0);
export async function checkoutTransaction(db,{orderId,items,paid,expectedTotal,user,actorName,seat}){
 if(!user||!/^[-_a-zA-Z0-9]{16,70}$/.test(orderId))throw Error('訂單識別不正確');
 if(!Array.isArray(items)||items.length===0||items.length>4||new Set(items.map(x=>x.id)).size!==items.length)throw Error('單次限 1～4 種商品');
 for(const x of items)checkedInt(x.qty,'購買數量',1,10000);
 checkedInt(paid,'實收金額',0);checkedInt(expectedTotal,'確認金額',0);
 const promosSnap=await getDocs(collection(db,'promotions'));
 const promos=promosSnap.docs.map(x=>({id:x.id,...x.data()}));
 const orderRef=doc(db,'orders',orderId);
 return await runTransaction(db,async tx=>{
  const existing=await tx.get(orderRef);
  if(existing.exists()){
    if(existing.data().soldByUid!==user.uid)throw Error('訂單已存在');
    return {total:existing.data().total,change:existing.data().change,duplicate:true};
  }
  const productRefs=items.map(x=>doc(db,'products',x.id));
  const productSnaps=await Promise.all(productRefs.map(r=>tx.get(r)));
  const products=productSnaps.map((snap,i)=>{
   if(!snap.exists())throw Error('有商品已被移除');
   const p={id:items[i].id,...snap.data()};
   if(p.hidden||!validRecipe(p))throw Error(p.name+' 無法結帳：配方不完整');
   checkedInt(p.price,'單價',1);checkedInt(p.sold||0,'已售數量');checkedInt(p.revenue||0,'商品營業額');
   return p;
  });
  const ingredientNeed=new Map();
  const lineIngredientUsage=new Map();
  for(let i=0;i<items.length;i++){
   const p=products[i],qty=items[i].qty,usage={};
   for(const part of p.recipe){
    const n=checkedInt(part.qty*qty,'原料消耗量',1);
    ingredientNeed.set(part.id,(ingredientNeed.get(part.id)||0)+n);
    usage[part.id]=n;
   }
   lineIngredientUsage.set(p.id,usage);
  }
  if(ingredientNeed.size>12)throw Error('本次原料種類過多，請分筆結帳');
  const ingredientIds=[...ingredientNeed.keys()].sort();
  const ingredientRefs=ingredientIds.map(id=>doc(db,'ingredients',id));
  const ingredientSnaps=await Promise.all(ingredientRefs.map(ref=>tx.get(ref)));
  for(let i=0;i<ingredientIds.length;i++){
   const id=ingredientIds[i],snap=ingredientSnaps[i];
   if(!snap.exists())throw Error('組合原料不存在，請重新整理');
   const ingredient=snap.data(),used=checkedInt(ingredient.usedQty||0,'已用原料'),stock=checkedInt(ingredient.totalQty,'總庫存');
   if(used+ingredientNeed.get(id)>stock)throw Error(ingredient.name+'庫存不足，請調整商品數量');
  }
  const promoRefs=promos.map(p=>doc(db,'promotions',p.id));
  const promoSnaps=await Promise.all(promoRefs.map(ref=>tx.get(ref)));
  const currentPromos=promoSnaps.filter(x=>x.exists()).map(x=>({id:x.id,...x.data()}));
  const cost=priceOrder(items,products,currentPromos);
  if(cost.total!==expectedTotal)throw Error('商品售價或優惠已更新，請返回重新核對金額');
  if(paid<cost.total)throw Error('實收金額不足');
  const count=cost.lines.reduce((n,x)=>n+x.qty,0);
  const qtyMap={},usageMap={};
  for(const line of cost.lines)qtyMap[line.id]=line.qty;
  for(const [id,n] of ingredientNeed)usageMap[id]=n;
  const actor=String(actorName||'').slice(0,35);
  const applied=cost.applied.map(a=>({id:a.id,productA:a.productA,productB:a.productB,count:a.count,saved:a.saved}));
  tx.set(orderRef,{soldByUid:user.uid,soldByName:actor,seat,createdAt:serverTimestamp(),productQty:qtyMap,ingredientUsage:usageMap,subtotal:cost.subtotal,discount:cost.discount,total:cost.total,paid,change:paid-cost.total,applied,count,status:'valid'});
  for(let i=0;i<items.length;i++){
   const p=products[i],line=cost.lines.find(x=>x.id===p.id);
   const saleId=orderId+'_'+p.id, saleRef=doc(db,'sales',saleId);
   const related=applied.filter(a=>a.productB===p.id);
   const sale={
    orderId,productId:p.id,productName:p.name,unit:p.unit||'個',
    qty:line.qty,unitPrice:p.price,grossPrice:line.gross,discountAmount:line.discount,
    totalPrice:line.lineTotal,recipeSnapshot:p.recipe,usedIngredients:lineIngredientUsage.get(p.id),
    promoId:related.length===1?related[0].id:'',
    promoCount:related.length===1?related[0].count:0,
    soldByUid:user.uid,soldByName:actor,seat,status:'valid',createdAt:serverTimestamp()
   };
   tx.set(saleRef,sale);
   tx.update(productRefs[i],{sold:(p.sold||0)+line.qty,revenue:(p.revenue||0)+line.lineTotal,lastSaleId:saleId,updatedAt:serverTimestamp()});
  }
  for(let i=0;i<ingredientIds.length;i++){
   const id=ingredientIds[i],old=ingredientSnaps[i].data();
   tx.update(ingredientRefs[i],{usedQty:(old.usedQty||0)+ingredientNeed.get(id),lastOrderId:orderId,updatedAt:serverTimestamp()});
  }
  const log=doc(collection(db,'audit'));
  tx.set(log,{action:'checkout',summary:'售出 '+count+' 單位，應收 NT$'+cost.total,actorUid:user.uid,actorName:actor,seat,subjectId:orderId,subjectType:'order',createdAt:serverTimestamp()});
  return {total:cost.total,change:paid-cost.total,duplicate:false};
 });
}

export async function refundTransaction(db,{saleId,reason,user,actorName,seat}){
 if(!user||typeof saleId!=='string'||saleId.length>200)throw Error('退款資料不正確');
 reason=String(reason||'').trim();
 if(!reason||reason.length>150)throw Error('請輸入退款原因（最多 150 字）');
 const saleRef=doc(db,'sales',saleId),logRef=doc(collection(db,'audit'));
 return runTransaction(db,async tx=>{
  const snap=await tx.get(saleRef);
  if(!snap.exists())throw Error('找不到交易紀錄');
  const sale=snap.data();
  if(sale.status!=='valid')throw Error('此筆交易已退款，無法重複退款');
  if(!validRecipe({recipe:sale.recipeSnapshot}))throw Error('舊交易缺少原料配方，請管理員手動核對');
  const productRef=doc(db,'products',sale.productId),productSnap=await tx.get(productRef);
  if(!productSnap.exists())throw Error('商品已移除，無法自動退款');
  const ids=[...new Set(sale.recipeSnapshot.map(p=>p.id))].sort();
  const refs=ids.map(id=>doc(db,'ingredients',id));
  const snaps=await Promise.all(refs.map(ref=>tx.get(ref)));
  const p=productSnap.data(),amount=checkedInt(sale.totalPrice,'退款金額'),qty=checkedInt(sale.qty,'退回數量',1);
  if((p.sold||0)<qty||(p.revenue||0)<amount)throw Error('商品帳目異常，請管理員核對');
  for(let i=0;i<ids.length;i++){
   const usage=checkedInt(sale.usedIngredients?.[ids[i]],'原料退回量',1);
   if(!snaps[i].exists()||(snaps[i].data().usedQty||0)<usage)throw Error('原料帳目異常，無法自動退款');
  }
  tx.update(saleRef,{status:'voided',refundReason:reason,refundedByUid:user.uid,refundedByName:String(actorName||'').slice(0,35),refundedAt:serverTimestamp()});
  tx.update(productRef,{sold:(p.sold||0)-qty,revenue:(p.revenue||0)-amount,lastRefundSaleId:saleId,updatedAt:serverTimestamp()});
  for(let i=0;i<ids.length;i++)tx.update(refs[i],{usedQty:(snaps[i].data().usedQty||0)-sale.usedIngredients[ids[i]],lastRefundSaleId:saleId,updatedAt:serverTimestamp()});
  tx.set(logRef,{action:'refund',summary:'退回 '+sale.productName+' × '+qty+'，NT$'+amount+'，原因：'+reason,actorUid:user.uid,actorName:String(actorName||'').slice(0,35),seat,subjectId:saleId,subjectType:'sale',createdAt:serverTimestamp()});
  return {amount};
 });
}
