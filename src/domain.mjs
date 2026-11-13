export function actionTarget(group,label){if(!group||!label)throw new Error('目标含糊');return {group,label};}
export function preview(data){return {revision:data.revision,mode:'manual-entry'};}
