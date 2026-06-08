import React, { useState } from 'react';
import './App.css';
import { API_BASE_URL } from './config';
import SinglePlayer from './components/SinglePlayer';
import MultiPlayer from './components/MultiPlayer';
import RegionGuide from './components/RegionGuide';

function App() {
    const [mode, setMode] = useState('menu');
    const [isRegionGuideOpen, setIsRegionGuideOpen] = useState(false);
    const [isUpdatingDataset, setIsUpdatingDataset] = useState(false);
    const [datasetUpdateResult, setDatasetUpdateResult] = useState(null);
    const [datasetUpdateError, setDatasetUpdateError] = useState('');

    const handleUpdateDataset = async () => {
        setIsUpdatingDataset(true);
        setDatasetUpdateError('');
        setDatasetUpdateResult(null);

        try {
            const response = await fetch(`${API_BASE_URL}/api/admin/update-dataset`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ strategy: 'browser_assisted' }),
            });

            const responseText = await response.text();
            let data;

            try {
                data = JSON.parse(responseText);
            } catch {
                throw new Error(
                    responseText.includes('<!DOCTYPE')
                        ? '服务端返回了网页内容而不是更新结果，请查看后端日志确认浏览器更新流程是否异常。'
                        : '服务端返回了无法识别的内容，请查看后端日志。'
                );
            }

            if (!response.ok) {
                throw new Error(data.error || '更新选手库失败');
            }

            setDatasetUpdateResult(data);
        } catch (error) {
            setDatasetUpdateError(error.message || '更新选手库失败');
        } finally {
            setIsUpdatingDataset(false);
        }
    };

    return (
        <div className="game-container">
            <div className="game-header">
                <h1 className="game-title">
                    弗一把
                    <span className="subtitle">Ultimate</span>
                </h1>
                {mode === 'menu' && (
                    <div className="header-actions">
                        <button 
                            className="guide-button"
                            onClick={() => setIsRegionGuideOpen(true)}
                        >
                            查看地区说明
                        </button>
                        <button
                            className="update-button"
                            onClick={handleUpdateDataset}
                            disabled={isUpdatingDataset}
                            title="自动打开浏览器、等待 HLTV 页面可用后更新选手库"
                        >
                            {isUpdatingDataset ? '更新中...' : '更新选手库'}
                        </button>
                    </div>
                )}
            </div>
            
            {mode === 'menu' && (
                <div className="menu-container">
                    <div className="menu-buttons">
                        <button onClick={() => setMode('single')}>单人模式</button>
                        <button className="disabled" disabled title="正在开发中">
                            多人对战
                            <span className="dev-badge">开发中</span>
                        </button>
                    </div>
                    {(datasetUpdateResult || datasetUpdateError) && (
                        <div className="dataset-update-panel">
                            {datasetUpdateError ? (
                                <>
                                    <h3>更新失败</h3>
                                    <p>{datasetUpdateError}</p>
                                    <p className="dataset-update-hint">
                                        这版会自动打开浏览器并等待 HLTV 页面就绪；如果失败，通常是浏览器没能通过验证、被关闭，或本机浏览器调试能力未就绪。
                                    </p>
                                </>
                            ) : (
                                <>
                                    <h3>更新完成</h3>
                                    <p>
                                        来源: {datasetUpdateResult.source === 'browser_assisted'
                                            ? '浏览器辅助更新'
                                            : datasetUpdateResult.source === 'live_hltv'
                                                ? 'HLTV 在线页面'
                                                : '本地缓存 HTML'}
                                    </p>
                                    <p>当前选手数: {datasetUpdateResult.totalPlayers}</p>
                                    <p>新增选手: {datasetUpdateResult.addedCount}</p>
                                    <p>移除选手: {datasetUpdateResult.removedCount}</p>
                                    <p>更新时间: {new Date(datasetUpdateResult.updatedAt).toLocaleString()}</p>
                                    {datasetUpdateResult.addedPreview?.length > 0 && (
                                        <p>新增示例: {datasetUpdateResult.addedPreview.join(', ')}</p>
                                    )}
                                    {datasetUpdateResult.removedPreview?.length > 0 && (
                                        <p>移除示例: {datasetUpdateResult.removedPreview.join(', ')}</p>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                    <footer className="game-footer">
                        <p>Made by Luminosity</p>
                        <p>Special Thanks: Ronnie Yang</p>
                    </footer>
                </div>
            )}
            
            {mode === 'single' && <SinglePlayer />}
            <RegionGuide 
                isOpen={isRegionGuideOpen}
                onClose={() => setIsRegionGuideOpen(false)}
            />
        </div>
    );
}

export default App;
