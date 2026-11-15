let state=await(await fetch('/api/snapshot')).json();
document.querySelector('[name=quantity]').oninput=event=>{document.querySelector('#amount').textContent=String(Number(event.target.value)*10);};
document.querySelector('#review').onclick=()=>{document.querySelector('#summary').textContent=JSON.stringify(Object.fromEntries(new FormData(document.querySelector('#entry'))));document.querySelector('dialog').showModal();};
document.querySelector('#cancel').onclick=()=>document.querySelector('dialog').close();
document.querySelector('#confirm').onclick=async()=>{const fields=Object.fromEntries(new FormData(document.querySelector('#entry')));const response=await fetch('/api/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fields)});document.querySelector('#receipt').textContent=JSON.stringify(await response.json());document.querySelector('dialog').close();};
if(state.duplicate){const group=document.createElement('fieldset');group.innerHTML='<legend>付款方</legend><label>名称<input name="payer"></label>';document.querySelector('#entry').prepend(group);}
if(state.duplicateName){const group=document.createElement('fieldset');group.dataset.group='contact';group.innerHTML='<legend>联系人（备用）</legend><label>名称<input name="contact"></label>';const anchor=document.querySelector('[data-group=contact]');anchor.before(group);}
if(state.reordered)document.querySelector('#entry').prepend(document.querySelector('[data-group=contact]'));
window.portalReady=true;
