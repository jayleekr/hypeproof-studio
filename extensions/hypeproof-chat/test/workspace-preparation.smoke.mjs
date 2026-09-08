import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareWorkspaceDirectory} from '../src/workspacePreparation.ts';
const root=mkdtempSync(join(tmpdir(),'hps-workspace-control-'));
try{
 const empty=join(root,'empty');prepareWorkspaceDirectory(empty,'empty',()=>{throw Error('empty trial must not render starter');});assert.deepEqual(readdirSync(empty),[]);
 const web=join(root,'web');prepareWorkspaceDirectory(web,'html',()=>'<h1>synthetic web starter</h1>');assert.equal(readFileSync(join(web,'index.html'),'utf8'),'<h1>synthetic web starter</h1>');
 writeFileSync(join(web,'index.html'),'<h1>user work</h1>');prepareWorkspaceDirectory(web,'html',()=>'<h1>replacement</h1>');prepareWorkspaceDirectory(web,'empty',()=>'<h1>replacement</h1>');assert.equal(readFileSync(join(web,'index.html'),'utf8'),'<h1>user work</h1>');
 const note=join(root,'note');mkdirSync(note);writeFileSync(join(note,'notes.md'),'user notes');prepareWorkspaceDirectory(note,'empty',()=>'<html>');assert.deepEqual(readdirSync(note),['notes.md']);assert.equal(readFileSync(join(note,'notes.md'),'utf8'),'user notes');
 console.log('PASS actual filesystem: empty trial / web curriculum positive control / existing work / nonweb files');
}finally{rmSync(root,{recursive:true,force:true});}
